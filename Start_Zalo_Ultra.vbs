Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client\launcher"
WshShell.Run Chr(34) & "C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client\launcher\zalo-ultra-v2.exe" & Chr(34) & " --data-dir=""D:\Zalo_Test_Env\AppData\Roaming\ZaloData"" --port=9333 --compact-interval=120", 0, False
Set WshShell = Nothing
