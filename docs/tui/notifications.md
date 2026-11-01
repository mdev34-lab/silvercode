# TUI desktop notifications

The built-in notifications plugin already sends session completion, permission,
question and error events through `attention.notify()`. Native delivery uses that
same host, focus policy and event deduplication, not another event listener.
Subagent completion remains sound-only, avoiding a notification for every child.
A foreground review completing with its session uses the session completion alert.

Enable attention in `tui.json` (it is off by default):

```json
{
  "attention": {
    "enabled": true,
    "notifications": true,
    "notification_backend": "auto",
    "sound": false
  }
}
```

- `auto` (default): native desktop first, terminal notification if unavailable.
- `native`: desktop only, without terminal fallback.
- `terminal`: preserve terminal-only delivery.
- `enabled: false` disables all attention; `notifications: false` disables
  notifications without disabling the existing sound system.

Native delivery needs no new package dependency:

- Windows: built-in Windows PowerShell and Windows Forms `NotifyIcon`. A temporary
  tray icon carries the balloon notification, then is disposed after six seconds.
  It does not activate or raise the terminal window. System notification settings
  control whether a balloon is shown and may supply their own notification sound.
- macOS: `osascript` with `display notification` (subject to OS permissions).
- Linux: `notify-send` and a desktop notification service, with DISPLAY or
  WAYLAND_DISPLAY. Headless hosts use terminal fallback in auto mode.

SSH sessions never send native notifications on the remote desktop. They keep
terminal delivery in auto mode. Native helper failures and missing tools are
nonfatal. Helper processes have a ten-second timeout, do not inherit terminal
input/output, and receive notification text as data, never interpolated commands.
Helpers receive only allowlisted OS/runtime and desktop-session environment
variables, not application credentials. Disposing the attention host aborts any
pending helper and ignores late results. This cannot retract a notification that
the OS already accepted before disposal.

The built-in plugin notifies only after the terminal has reported blur. Focused
or unknown focus remains silent; terminals without focus reporting may therefore
not notify. This change does not guess focus or add window polling. OS focus-assist
and notification settings can suppress a notification even when delivery succeeds.

## Manual Windows verification still needed

With attention enabled, blur the terminal while a session runs; confirm one
balloon on completion. Repeat for a question and permission. Confirm no balloon
while focused, with attention disabled, and with notifications disabled. Check
that the temporary tray icon disappears and the terminal never steals focus.
