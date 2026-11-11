param(
  [Parameter(Mandatory = $true)][ValidateSet("baseline", "chcp", "setconsole")][string]$Mode,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$FileName,
  [Parameter(Mandatory = $true)][string]$FileText
)

$ErrorActionPreference = "Stop"

Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeConsoleProbe
{
    public const int STD_OUTPUT_HANDLE = -11;

    [DllImport("kernel32.dll")]
    public static extern uint GetConsoleCP();

    [DllImport("kernel32.dll")]
    public static extern uint GetConsoleOutputCP();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCP(uint codePage);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleOutputCP(uint codePage);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WriteConsoleW(
        IntPtr handle,
        string text,
        uint length,
        out uint written,
        IntPtr reserved);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr handle,
        byte[] bytes,
        uint length,
        out uint written,
        IntPtr overlapped);

    public static void WriteWide(string text)
    {
        uint written;
        bool ok = WriteConsoleW(GetStdHandle(STD_OUTPUT_HANDLE), text, (uint)text.Length, out written, IntPtr.Zero);
        int error = Marshal.GetLastWin32Error();
        if (!ok) throw new Win32Exception(error, "WriteConsoleW failed");
        if (written != (uint)text.Length) throw new InvalidOperationException("WriteConsoleW partial write");
    }

    public static void WriteBytes(byte[] bytes)
    {
        uint written;
        bool ok = WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, (uint)bytes.Length, out written, IntPtr.Zero);
        int error = Marshal.GetLastWin32Error();
        if (!ok) throw new Win32Exception(error, "WriteFile failed");
        if (written != (uint)bytes.Length) throw new InvalidOperationException("WriteFile partial write");
    }
}
'@

function Emit-Line([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function Emit-Cp([string]$stage) {
  $payload = [ordered]@{
    stage = $stage
    input = [NativeConsoleProbe]::GetConsoleCP()
    output = [NativeConsoleProbe]::GetConsoleOutputCP()
  } | ConvertTo-Json -Compress
  Emit-Line ("PROBE_CP " + $payload)
}

function Emit-SetOutputCp {
  $ok = [NativeConsoleProbe]::SetConsoleOutputCP([uint32]65001)
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $payload = [ordered]@{
    requested = 65001
    success = $ok
    lastError = $errorCode
  } | ConvertTo-Json -Compress
  Emit-Line ("PROBE_SETCPOUTPUT " + $payload)
}

function Write-WideText([string]$text) {
  [NativeConsoleProbe]::WriteWide($text)
}

function Write-RawBytes([byte[]]$bytes) {
  [NativeConsoleProbe]::WriteBytes($bytes)
}

function Invoke-Cmd([string]$arguments) {
  $process = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = $arguments
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $process = [System.Diagnostics.Process]::Start($psi)
    if (-not $process.WaitForExit(10000)) {
      try { $process.Kill() } catch {}
      throw ("Invoke-Cmd timed out: " + $arguments)
    }
    return $process.ExitCode
  } finally {
    if ($process) { $process.Dispose() }
  }
}

Set-Location -LiteralPath $WorkDir
Emit-Cp "before"

switch ($Mode) {
  "chcp" {
    $code = Invoke-Cmd "/d /c chcp 65001 >nul"
    Emit-Line ("PROBE_CHCP_EXIT " + $code)
    Emit-Cp "after-chcp"
  }
  "setconsole" {
    Emit-SetOutputCp
    Emit-Cp "after-setconsoleoutputcp"
  }
  default {
    Emit-Cp "baseline"
  }
}

Emit-Line "PROBE_STAGE native-controls-start"

# Control 1: legitimate wide output through WriteConsoleW. This must not be codepage-expanded.
Emit-Line "PROBE_CONTROL_START legit-wide"
Write-WideText ("PROBE_WIDE " + [char]0x251C + [char]0x00BA + "`r`n")
Emit-Line "PROBE_CONTROL_END legit-wide"

# Control 2: OSC title containing the same legitimate wide text.
Emit-Line "PROBE_CONTROL_START osc-title"
Write-WideText ("PROBE_OSC " + [char]27 + "]0;" + [char]0x251C + [char]0x00BA + [char]7 + "`r`n")
Emit-Line "PROBE_CONTROL_END osc-title"

# Control 3a: legitimate wide U+00E9 U+251C U+00BA in one WriteConsoleW call.
Emit-Line "PROBE_CONTROL_START legit-wide-eacute-full"
Write-WideText ("PROBE_WIDE2 " + [char]0x00E9 + [char]0x251C + [char]0x00BA + "`r`n")
Emit-Line "PROBE_CONTROL_END legit-wide-eacute-full"

# Control 3b: the same legitimate wide text split across two WriteConsoleW calls.
Emit-Line "PROBE_CONTROL_START legit-wide-eacute-split"
Write-WideText ("PROBE_WIDE2 " + [char]0x00E9)
Write-WideText ([char]0x251C + [char]0x00BA + "`r`n")
Emit-Line "PROBE_CONTROL_END legit-wide-eacute-split"

# Provenance B: UTF-8 bytes written to the console stdout handle through WriteFile.
Emit-Line "PROBE_CONTROL_START utf8-raw-bytes"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$utf8Text = "PROBE_UTF8 a" + [char]0x00E7 + [char]0x00E3 + "o-" + [char]0x65E5 + [char]0x672C + "`r`n"
Write-RawBytes $utf8.GetBytes($utf8Text)
Emit-Line "PROBE_CONTROL_END utf8-raw-bytes"

# Provenance C: raw console-output-codepage bytes (CP437). Different provenance from UTF-8/wide output.
Emit-Line "PROBE_CONTROL_START raw-cp437-full"
Emit-Line "PROBE_RAW_CP437 full bytes=0x82,0xC3,0xA7 provenance=console-output-codepage"
Write-RawBytes ([byte[]](0x82, 0xC3, 0xA7))
Write-WideText "`r`n"
Emit-Line "PROBE_CONTROL_END raw-cp437-full"

Emit-Line "PROBE_CONTROL_START raw-cp437-split"
Emit-Line "PROBE_RAW_CP437 split bytes=0x82|0xC3,0xA7 provenance=console-output-codepage"
Write-RawBytes ([byte[]](0x82))
Start-Sleep -Milliseconds 40
Write-RawBytes ([byte[]](0xC3, 0xA7))
Write-WideText "`r`n"
Emit-Line "PROBE_CONTROL_END raw-cp437-split"

# Provenance C: lone raw 0xC3 byte; before-exit latency is not proven by this shape.
Emit-Line "PROBE_CONTROL_START standalone-cp437"
Emit-Line "PROBE_RAW_CP437 standalone bytes=0xC3 provenance=console-output-codepage"
Emit-Line "PROBE_NOTE standalone-before-exit-latency=UNVERIFIED"
Write-RawBytes ([byte[]](0xC3))
Write-WideText "`r`n"
Emit-Line "PROBE_CONTROL_END standalone-cp437"

Emit-Line "PROBE_STAGE native-controls-end"

Emit-Line "PROBE_STAGE file-type-start"
$typeCode = Invoke-Cmd "/d /c type *.txt"
Emit-Line ("PROBE_CMD_EXIT type " + $typeCode)
Emit-Line "PROBE_STAGE file-type-end"

Emit-Line "PROBE_STAGE dir-start"
$dirCode = Invoke-Cmd "/d /c dir /b"
Emit-Line ("PROBE_CMD_EXIT dir " + $dirCode)
Emit-Line "PROBE_STAGE dir-end"

Emit-Cp "after-commands"
Emit-Line "PROBE_DONE"
