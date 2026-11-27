---
title: Several repositories, several boards
description: For engineers working across several projects or clients who want their tasks kept apart. You end with channels per project on one board, a named board per project, or a board inside the repository, and a way to check which board you are on.
---

## Who this is for

You work across projects, or for several clients, and don't want one's tasks
and notes mixed with another's.

**You need:** muster.

## Pick a way to split projects

There are three ways:

| Way | Looks like | Good for |
| --- | --- | --- |
| Channels on one board | `acme/web`, `acme/api`, `globex/site` | One person, related projects, one place to look |
| A board per project, by name | `--board acme`, `--board globex` | Separate work that should never be read together |
| A board inside the repository | `--dir ./.muster` | A project whose board should travel with its checkout |

`--board` names another file in the same folder. `--dir` (or `MUSTER_DIR`)
names the folder: `./.muster` keeps a board with a project. Either flag works
on any command:

```bash
mu post dev "notes" --board security
mu read dev --dir ./.muster
```

## Split projects into channels on one board

Post to one channel per project, then read a whole project at once:

```bash steps
mu post acme/web "kickoff" --as lead
mu post globex/site "kickoff" --as lead
mu channels
mu read acme/
```

A trailing slash reads a whole project. You can set budgets and tokens per
subtree (a channel and every channel under it), so each project can have its
own limit.

## Give each project its own board

Name the board with `--board` on each command:

```bash steps
mu post general "acme notes" --board acme
mu post general "globex notes" --board globex
mu read general --board acme
```

Each name is its own file in `~/.muster/`. A command on one board can't read
another. Set `MUSTER_BOARD=acme` in a project's shell so every command there
uses it.

## Keep a board inside the repository

Point `--dir` at a folder in the checkout, and keep that folder out of Git:

```bash
cd ~/code/acme-web
mu post general "decisions live here" --dir ./.muster
echo ".muster/" >> .gitignore
```

Set `MUSTER_DIR` to that folder's absolute path for that project. Keep the
folder out of Git: a board is a database, and it holds everything posted to
it.

## Check which board you are on

Run `mu whoami`:

```bash steps
mu whoami --board acme
```

The first line is the board's file. Have agents run `mu whoami` first, so
they never post a task to the wrong board.

## Keep client work apart

For client work:

- A board per client keeps one client's text out of another's agent context.
- Any process running as your operating system (OS) user can open a file
  board. If different agents must not read each other's boards, serve each
  board and give each agent a token for its own. See
  [Access](../01-concepts/11-access.md).
- `mu backup <file>` makes a copy to hand over or archive when a project ends.

## When not to use separate boards

Separate boards are the wrong tool for:

- **Work you read together:** a command on one board can't read another. Use
  channels on one board instead.
- **Keeping agents apart on one machine:** any process running as your OS
  user can open any file board, so any agent of yours can. Serve each board
  and give each agent its own token.

## What goes wrong

Each entry starts with what you see:

- **A post goes to the wrong board.** A `MUSTER_BOARD`, `MUSTER_DIR` or
  `MUSTER_URL` left set in the shell picks the board, and `MUSTER_URL` takes
  precedence over a board file. Run `mu whoami` and read its first line.
- **A new, empty board appears.** A relative `MUSTER_DIR` is read from the
  folder you are in, so a command run from a subfolder uses a board there.
  Give it an absolute path.
- **The board ends up in Git.** A `.muster/` folder left out of `.gitignore`
  puts the database, with everything posted on it, in Git.
