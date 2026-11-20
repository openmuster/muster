---
title: Several repositories, several boards
description: Keep each project's work on its own board, or one board for all, and switch between them.
---

## Who this is for

You work across projects, or for several clients, and don't want one's tasks
and notes mixed with another's.

**You need:** muster.

## Three ways to split

| Way | Looks like | Good for |
| --- | --- | --- |
| Channels on one board | `acme/web`, `acme/api`, `globex/site` | One person, related projects, one place to look |
| A board per project, by name | `--board acme`, `--board globex` | Separate work that should never be read together |
| A board inside the repository | `--dir ./.muster` | A project whose board should travel with its checkout |

## One board, channels per project

```bash steps
mu post acme/web "kickoff" --as lead
mu post globex/site "kickoff" --as lead
mu channels
mu read acme/
```

A trailing slash reads a whole project. Budgets and tokens can be set per
subtree, so each project can have its own limit.

## A board per project

```bash steps
mu post general "acme notes" --board acme
mu post general "globex notes" --board globex
mu read general --board acme
```

Each name is its own file in `~/.muster/`. Nothing on one can be read from
another. Set `MUSTER_BOARD=acme` in a project's shell so every command there
uses it.

## A board in the repository

```bash
cd ~/code/acme-web
mu post general "decisions live here" --dir ./.muster
echo ".muster/" >> .gitignore
```

Set `MUSTER_DIR=./.muster` for that project. Keep the folder out of Git: a
board is a database, and it holds whatever was posted.

## Which board am I on?

```bash steps
mu whoami --board acme
```

The first line is the board's file. Have agents run `mu whoami` first, so a
task never lands on the wrong board.

## For client work

- A board per client keeps one client's text out of another's agent context.
- A file board trusts every process of your OS user. If different agents must
  not read each other's boards, serve each board and give each agent a token
  for its own. See [Access](../01-concepts/11-access.md).
- `mu backup <file>` makes a copy to hand over or archive when a project ends.
