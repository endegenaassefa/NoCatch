# Instance lifecycle regression checks

Run from the repository root with Node 22 or newer on Windows:

```powershell
node --test scripts/instance-qa/startup.test.cjs scripts/instance-qa/windows-pipe.test.cjs scripts/instance-qa/activation.test.cjs scripts/instance-qa/stop.test.cjs scripts/instance-qa/pending-launch.test.cjs scripts/instance-qa/system-helper.test.cjs
```

The startup tests execute production main and ownership logic with external service/storage/Electron fixtures. Pipe tests use real Windows named pipes and isolated child processes. Stop and launcher tests execute real PowerShell functions with inert OS mutation boundaries. The helper check compiles real SystemLauncher.cs and invokes only JSON conversion through reflection; it never starts the SYSTEM service. Activation checks run the real controller method against window outputs. Tests never read user credentials or launch the app GUI.

Native Windows cases skip on other platforms; the four activation checks remain runnable. `NOCATCH_QA_SOURCE` can point at another source checkout. Windows helper checks require the .NET Framework compiler and Windows PowerShell already used by the production launcher.

These checks do not prove UAC interaction, actual integrity-token transitions, RDP behavior, or the complete visible app lifecycle. Keep live Windows checks for cancellation, elevated Stop, mode switching, and focus. Simulated integrity labels in pipe tests are not evidence of elevated ACL behavior.

The independent Windows repair run also tested the installed app: eight cold starts admitted one owner, duplicate normal/profile launches exited, minimized onboarding refocused, and Admin/Exam launchers preserved an existing normal owner with a clear mode-conflict message and exit 2.
