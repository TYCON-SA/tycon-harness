# windows-console-watch.ps1 — anota cada ventana de consola que aparece en el escritorio, mientras exista -StopFile.
#
# Por qué: una ventana de consola que se abre y se cierra en medio segundo no la ve nadie que cuente ventanas de a ratos.
# Este vigilante se suscribe al aviso de Windows «se mostró una ventana» (SetWinEventHook, EVENT_OBJECT_SHOW, fuera del
# proceso: no pide permisos de administrador) y anota cada una en el momento, aunque dure un instante.
#
# Qué anota: una línea JSON por ventana de consola que se mostró (las de conhost, «ConsoleWindowClass», y las de Windows
# Terminal, «CASCADIA_HOSTING_WINDOW_CLASS»), con la hora en milisegundos, la clase, el proceso dueño, su nombre y su
# padre. La primera línea es {"ready":true}: quien lo lanza espera esa línea antes de empezar a medir.
# Sólo mira: no cambia nada de la máquina. Termina solo cuando -StopFile existe, o a los -MaxSeconds.
#
# Uso (lo lanza scripts/tools/windows-console-probe.js):
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows-console-watch.ps1 -Out <eventos.jsonl> -StopFile <archivo> [-MaxSeconds 1800]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$StopFile,
  [int]$MaxSeconds = 1800
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ConsoleWatch {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint n, IntPtr[] handles, bool all, uint ms, uint mask);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int size, out int ret);

  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr r1; public IntPtr peb; public IntPtr r2a; public IntPtr r2b; public IntPtr pid; public IntPtr parent; }

  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const uint PM_REMOVE = 1;
  const uint QS_ALLINPUT = 0x04FF;
  const uint GA_ROOT = 2;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  static StreamWriter writer;
  static WinEventProc keep;

  static string Esc(string s) {
    var sb = new StringBuilder();
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
      else sb.Append(c);
    }
    return sb.ToString();
  }

  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

  static long ParentOf(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      var info = new PBI(); int ret;
      return NtQueryInformationProcess(h, 0, ref info, Marshal.SizeOf(info), out ret) == 0 ? info.parent.ToInt64() : -1;
    } finally { CloseHandle(h); }
  }

  static string NameOf(long pid) {
    if (pid <= 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, GA_ROOT) != hwnd) return;
    var cls = new StringBuilder(256);
    GetClassName(hwnd, cls, 256);
    string k = cls.ToString();
    if (k != "ConsoleWindowClass" && k != "CASCADIA_HOSTING_WINDOW_CLASS") return;
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    var title = new StringBuilder(512);
    GetWindowText(hwnd, title, 512);
    long parent = ParentOf(pid);
    writer.WriteLine("{\"t\":" + Now() + ",\"class\":\"" + Esc(k) + "\",\"pid\":" + pid + ",\"name\":\"" + Esc(NameOf(pid)) +
      "\",\"parent\":" + parent + ",\"parentName\":\"" + Esc(NameOf(parent)) + "\",\"title\":\"" + Esc(title.ToString()) + "\"}");
    writer.Flush();
  }

  public static void Run(string outFile, string stopFile, int maxSeconds) {
    writer = new StreamWriter(outFile, true, new UTF8Encoding(false));
    keep = OnEvent;
    IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, keep, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (hook == IntPtr.Zero) { writer.WriteLine("{\"ready\":false,\"error\":\"SetWinEventHook no anduvo\"}"); writer.Flush(); writer.Close(); return; }
    writer.WriteLine("{\"ready\":true,\"t\":" + Now() + "}");
    writer.Flush();
    long end = Now() + (long)maxSeconds * 1000;
    MSG msg;
    try {
      while (!File.Exists(stopFile) && Now() < end) {
        MsgWaitForMultipleObjects(0, null, false, 100, QS_ALLINPUT);
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
      }
    } finally {
      UnhookWinEvent(hook);
      writer.WriteLine("{\"done\":true,\"t\":" + Now() + "}");
      writer.Flush();
      writer.Close();
    }
  }
}
'@

try { [ConsoleWatch]::Run($Out, $StopFile, $MaxSeconds) }
catch {
  # el motivo va al archivo: quien lo lanzó dice NO MEDIDO con esta razón, no «sin respuesta»
  $why = ($_.Exception.Message -replace '[\\"]', "'" -replace '[\r\n]+', ' ')
  Add-Content -LiteralPath $Out -Value ('{"ready":false,"error":"' + $why + '"}') -Encoding UTF8
  exit 1
}
