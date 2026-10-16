Option Explicit

Dim fileSystem, shell, launcherDirectory, powershellPath, initializerPath
Dim command, exitCode

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

launcherDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & _
    "\System32\WindowsPowerShell\v1.0\powershell.exe"
initializerPath = fileSystem.BuildPath(launcherDirectory, "Initialize-LarkNotify.ps1")

If Not fileSystem.FileExists(powershellPath) Then WScript.Quit 1
If Not fileSystem.FileExists(initializerPath) Then WScript.Quit 1

command = QuoteArgument(powershellPath) & _
    " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
    QuoteArgument(initializerPath)

On Error Resume Next
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
    Err.Clear
    WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit exitCode

Function QuoteArgument(ByVal value)
    QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
