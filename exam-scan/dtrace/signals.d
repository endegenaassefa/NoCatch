#pragma D option quiet
/* signals.d — record every signal sent/handled system-wide, plus exec/exit.
 * Post-processing maps sender/recipient pids onto the Cluely / LockDown
 * Browser / Terminal trees using the per-tick census identity map.
 * Format: epoch-window|EVENT|sender_name|sender_pid|recipient_name|recipient_pid|detail
 */
proc:::signal-send
{
  printf("%Y|SIGNAL_SEND|%s|%d|%s|%d|%d\n", walltimestamp, execname, pid,
         args[1]->pr_fname, args[1]->pr_pid, args[2]);
}

proc:::signal-handle
{
  printf("%Y|SIGNAL_HANDLE|%s|%d|%s|%d|%d\n", walltimestamp, execname, pid,
         args[1]->pr_fname, args[1]->pr_pid, args[2]);
}

proc:::exec-success
{
  printf("%Y|EXEC|%s|%d|%s\n", walltimestamp, execname, pid, args[0]);
}

proc:::exit
{
  printf("%Y|EXIT|%s|%d|%d\n", walltimestamp, execname, pid, args[0]);
}
