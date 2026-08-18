' Запуск Aqua без чёрного окна консоли (как приложение).
' Двойной клик — стартует локальный сервер скрыто и открывает окно приложения.
' Остановить: Диспетчер задач → node.exe  (или пользуйся Запуск Aqua.bat с видимой консолью).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' 0 = скрытое окно, False = не ждать завершения
sh.Run "cmd /c node server.js", 0, False
