/**
 * Enumerate the top-level windows a user can capture, and resolve a saved
 * choice back to desktop pixels.
 *
 * GDI cannot read hardware-composited windows, so capture always ends up as a
 * rectangle of the composed desktop. Choosing "an app" therefore means: find
 * the window, take its bounds, crop the desktop.
 */
import { spawn } from 'node:child_process'

const CACHE_MS = 4000
let cache = { at: 0, windows: [], screen: { width: 0, height: 0 } }

const LIST_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class VRWindows {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> List() {
    var result = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      var sb = new StringBuilder(600);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      if (w < 120 || hh < 120) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      result.Add(string.Format("{0}\\t{1}\\t{2}\\t{3}\\t{4}\\t{5}", t, pid, r.Left, r.Top, w, hh));
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[void][VRWindows]::SetProcessDPIAware()
$screenObj = [ordered]@{ screen = $true; width = [VRWindows]::GetSystemMetrics(0); height = [VRWindows]::GetSystemMetrics(1) }
$screenObj | ConvertTo-Json -Compress
foreach ($line in [VRWindows]::List()) {
  $parts = $line -split "\`t"
  $title = $parts[0]
  $pidValue = $parts[1]
  $process = ""
  try { $process = (Get-Process -Id ([int]$pidValue) -ErrorAction Stop).ProcessName } catch { }
  $obj = [ordered]@{ title = $title; process = $process; pid = [int]$pidValue; x = [int]$parts[2]; y = [int]$parts[3]; width = [int]$parts[4]; height = [int]$parts[5] }
  $obj | ConvertTo-Json -Compress
}
`

function runPowerShell(script, env = {}) {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...env },
    })
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8') })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(output))
  })
}

/**
 * List capturable windows.
 * @param {number} [maxAgeMs] cache age to accept.
 * @returns {Promise<{title: string, process: string, pid: number, x: number, y: number, width: number, height: number}[]>} windows.
 */
export async function listWindows(maxAgeMs = CACHE_MS) {
  if (Date.now() - cache.at < maxAgeMs && cache.windows.length > 0) return cache.windows
  const output = await runPowerShell(LIST_SCRIPT)
  const windows = []
  let screen = { width: 0, height: 0 }
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const entry = JSON.parse(trimmed)
      if (entry.screen) {
        screen = { width: Number(entry.width) || 0, height: Number(entry.height) || 0 }
        continue
      }
      if (!entry.title || !Number.isFinite(entry.width)) continue
      windows.push({
        title: String(entry.title),
        process: String(entry.process ?? ''),
        pid: Number(entry.pid) || 0,
        x: Number(entry.x) || 0,
        y: Number(entry.y) || 0,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
      })
    } catch { /* skip malformed line */ }
  }
  // gdigrab rejects a rectangle that reaches outside the desktop, and a
  // maximized window routinely does (borders sit a few pixels off-screen).
  for (const entry of windows) {
    if (screen.width > 0) {
      entry.x = Math.min(Math.max(0, entry.x), Math.max(0, screen.width - 16))
      entry.width = Math.min(entry.width, screen.width - entry.x)
    }
    if (screen.height > 0) {
      entry.y = Math.min(Math.max(0, entry.y), Math.max(0, screen.height - 16))
      entry.height = Math.min(entry.height, screen.height - entry.y)
    }
    entry.width = Math.max(16, entry.width - (entry.width % 2))
    entry.height = Math.max(16, entry.height - (entry.height % 2))
  }
  windows.sort((a, b) => (b.width * b.height) - (a.width * a.height))
  cache = { at: Date.now(), windows, screen }
  return windows
}

/** Desktop size as reported by the same enumeration. */
export function screenBounds() {
  return cache.screen ?? { width: 0, height: 0 }
}

/**
 * Resolve a saved window choice to bounds.
 * Matching order: exact title, title substring, process name.
 * @param {{title?: string, process?: string}} choice saved selection.
 * @returns {Promise<{rect: object, window: object}|undefined>} the match.
 */
export async function resolveWindow(choice = {}) {
  const windows = await listWindows()
  const title = String(choice.title ?? '').trim()
  const process = String(choice.process ?? '').trim().toLowerCase().replace(/\.exe$/, '')
  if (title) {
    const exact = windows.find((entry) => entry.title === title)
    if (exact) return { rect: toRect(exact), window: exact }
  }
  if (title) {
    const lower = title.toLowerCase()
    const partial = windows.find((entry) => entry.title.toLowerCase().includes(lower))
    if (partial) return { rect: toRect(partial), window: partial }
  }
  if (process) {
    const byProcess = windows.find((entry) => entry.process.toLowerCase() === process)
    if (byProcess) return { rect: toRect(byProcess), window: byProcess }
  }
  return undefined
}

function toRect(entry) {
  return { x: entry.x, y: entry.y, width: entry.width, height: entry.height }
}
