---
nav_order: 10
---

# Scheduled tasks

Circle can run a prompt on a clock: a nightly summary of the day, a weekly triage,
one check tomorrow morning. A schedule is a standing prompt for one folder; each time it is
due, Circle runs it headless, like `circle -p`, and writes the answer to a log. It never
forgets a prompt you gave it once, and nothing runs when nothing is due.

```bash
circle schedule add notes "summarize yesterday's commits in NOTES.md" --daily 09:30
circle schedule start
```

## What a schedule is

A schedule has a name, a prompt, one folder it works in, and a clock. The folder is the
project it answers about: the run trusts the folder (you chose it when you made the
schedule), reads its instruction files and runs its tools there, exactly as a
`circle -p "..." <folder>` would. A run is a conversation of its own; it is saved like any
other session and can be opened with `/resume`. What it printed goes to a log under the
data folder (`schedules/<name>/runs/`), and each schedule keeps its last fifty runs in a
history.

The clocks:

| Flag | Meaning |
|---|---|
| `--every 15m` | a plain spacing: `45s` up to `365d`, at least one minute |
| `--daily 09:30` | every day at that local time |
| `--cron "30 9 * * 1-5"` | five fields — minute, hour, day of month, month, day of week — in local time; `*`, lists (`1,15`), ranges (`1-5`) and steps (`5/15`, `*/10`) |
| `--at "2026-11-02 07:00"` | once, then done; a bare `--at 07:00` means the next time that clock reads |

Circle's own words for these are in the CLI reference, [CLI](cli.md#scheduled-tasks), and
in `circle schedule --help`.

## Managing schedules

```bash
circle schedule add NAME PROMPT <clock> [-w FOLDER] [-m MODEL] [--yolo] [--extensions]
circle schedule list
circle schedule show NAME
circle schedule pause NAME
circle schedule resume NAME
circle schedule remove NAME
circle schedule run NAME
```

- Without `-w`, a schedule works in the folder you made it from.
- Without `-m`, it uses the model from settings, `default_thinking` and all.
- `circle schedule run NAME` runs it once, now, apart from its clock: the clock does not
  move and a failed manual run is not counted.
- `list` shows each schedule, its clock and its next run; `show` adds the prompt, the
  folder, the flags and the last five runs.

## Keeping the clock running

Schedules fire while the **scheduler** runs. It is one background process per data folder:

```bash
circle schedule start      # keep firing schedules in the background
circle schedule stop
circle schedule status     # whether it runs, and what comes next
```

`start` detaches; the scheduler's own output goes to `schedules/daemon.log` in the data
folder. `circle schedule daemon` runs the same loop in the terminal you can watch. While no
scheduler runs, nothing fires: a missed time is skipped and the next one waits. To keep
that window small, run `circle schedule tick` from your own cron or Task Scheduler
instead of the daemon: it fires everything that is due and exits.

One run of one schedule at a time, whatever asked for it: a tick that finds a schedule
still running leaves it for the next. The scheduler runs at most three schedules at once
and takes the rest on the next tick; `circle schedule tick` fires everything due at once. A run that passes four hours is stopped. The run's approvals
follow your saved `default_mode`; for an unattended schedule that should edit or run
commands freely, give it `--yolo` when you make it. `--extensions` loads your extensions
and MCP servers into the run, as they are for `circle -p --extensions`. A project's hooks
files that you have not approved are skipped, as in any headless run.

## When a run fails

The status, exit code and log line of every run are kept in the schedule's history. If
three scheduled runs of one schedule fail in a row, Circle pauses it and says why, so a
broken endpoint or a moved folder does not burn tokens all night; fix the cause and
`circle schedule resume NAME`. A `--at` schedule that fails its one run pauses with a note
instead of trying again every tick; one that answers is marked done.

## Safety

- The prompt, folder and clock of a schedule are kept in `schedules/<name>/schedule.json`,
  readable only by you.
- A schedule runs with your model endpoint and your key, without asking. Make the prompt
  the kind you would leave running on your own machine; `--yolo` means no approvals on a
  run that nobody is watching.
- Removing a schedule deletes its folder with its logs: `circle schedule remove NAME`.
- Schedules are stored in the data folder, not in the project they work in.

## Notes

- Clocks follow your machine's local time. A wall time that daylight saving skips does not
  come that day.
- The first run of `--every` is one spacing after you add it, not at once. If you want it
  now, run `circle schedule run NAME`.
- The desktop application does not show or run schedules yet.