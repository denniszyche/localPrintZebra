Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
quote = Chr(34)
command = "cmd.exe /c " & quote & quote & appDir & "\\start-windows.cmd" & quote & quote

shell.Run command, 0, False