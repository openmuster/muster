import { whileBusy, type Db } from './sqlite.ts'

/**
 * The version of the tables below. A file with a newer one is refused; an older one gets the tables it
 * lacks. Every statement is `if not exists`, so the upgrade from any earlier version is to run them all.
 */
export const STORE_VERSION = 6

const DDL = `
create table if not exists events (
  seq integer primary key autoincrement,
  at text not null,
  type text not null,
  principal text not null,
  profile text,
  channel text,
  thread integer,
  data text not null
);
create index if not exists events_thread on events (thread, seq);
create index if not exists events_channel on events (channel, seq);
create trigger if not exists events_no_update before update on events begin select raise(abort, 'events are append-only'); end;
create trigger if not exists events_no_delete before delete on events begin select raise(abort, 'events are append-only'); end;

create table if not exists channels (
  path text primary key,
  created_seq integer not null,
  private integer not null default 0
) without rowid;

create table if not exists messages (
  id integer primary key,
  channel text not null,
  thread integer not null,
  re integer,
  reply_to integer,
  principal text not null,
  profile text,
  text text not null,
  labels text not null default '{}',
  reactions text not null default '{}',
  attachments text not null default '[]',
  revision integer not null default 1,
  deleted integer not null default 0,
  no_sync integer not null default 0,
  at text not null,
  edited_at text,
  activity integer not null
);
create index if not exists messages_thread on messages (thread, id);
create index if not exists messages_roots on messages (channel, activity) where re is null;

create table if not exists actors (
  principal text not null,
  profile text not null default '',
  handle text not null,
  first_seq integer not null,
  last_seq integer not null,
  primary key (principal, profile)
) without rowid;

create table if not exists idempotency (
  key text primary key,
  fingerprint text not null,
  answer text not null,
  seq integer not null
) without rowid;

create table if not exists tasks (
  id integer primary key,
  owner text not null,
  owner_profile text,
  for_profile text,
  state text not null check (state in ('waiting','ready','claimed','blocked','completed','failed','canceled')),
  hold_kind text,
  hold_reason text,
  result text,
  reason text,
  epoch integer not null default 0,
  claim_principal text,
  claim_profile text,
  claim_until text,
  claim_token text,
  claim_renewed text,
  claim_pid integer,
  claim_pid_start text,
  attempts integer not null default 0,
  rounds integer not null default 0,
  created_seq integer not null,
  updated_seq integer not null
);
create index if not exists tasks_state on tasks (state, id);

create table if not exists needs (
  task integer not null,
  needs integer not null,
  primary key (task, needs)
) without rowid;
create index if not exists needs_reverse on needs (needs, task);

create table if not exists schedules (
  id integer primary key,
  principal text not null,
  profile text,
  channel text not null,
  thread integer,
  text text not null,
  every_s integer,
  times integer,
  until text,
  fired integer not null default 0,
  next_at text,
  canceled integer not null default 0
);

create table if not exists slots (
  schedule integer not null,
  slot text not null,
  message integer not null,
  primary key (schedule, slot)
) without rowid;

create table if not exists budgets (
  channel text primary key,
  usd real not null
) without rowid;

create table if not exists schemas (
  name text not null,
  version integer not null,
  schema text not null,
  primary key (name, version)
) without rowid;

create table if not exists links (
  message integer not null,
  key text not null,
  external text not null,
  thread_external text,
  place text,
  primary key (key, external)
) without rowid;
create index if not exists links_message on links (message, key);

create virtual table if not exists messages_fts using fts5 (text, content = '', contentless_delete = 1);

-- Platform events as they arrived, kept until imported. Bookkeeping: not in the log.
create table if not exists inbox (
  key text not null,
  id text not null,
  received text not null,
  payload text not null,
  attempts integer not null default 0,
  done integer not null default 0,
  primary key (key, id)
) without rowid;

-- What couldn't be delivered yet, and how often it was tried.
create table if not exists outbox_attempts (
  key text not null,
  seq integer not null,
  attempts integer not null default 0,
  primary key (key, seq)
) without rowid;

-- Reader bookkeeping. Not a board fact: it is not in the log and a fold doesn't rebuild it.
create table if not exists cursors (
  name text not null,
  profile text not null default '',
  seq integer not null,
  primary key (name, profile)
) without rowid;

-- The tokens this board has made: enough to list one and to stop it, never the token itself.
create table if not exists tokens (
  id text primary key,
  profile text,
  can text,
  exp integer not null,
  at integer not null,
  revoked integer not null default 0
) without rowid;

-- Requests to join a served board, for minutes: who asked, a hash of the secret only they hold, and
-- once the owner approves, the token waiting for them to pick it up.
create table if not exists joins (
  code text primary key,
  profile text not null,
  note text,
  secret blob not null,
  at integer not null,
  expires integer not null,
  state text not null,
  token text
) without rowid;
`

/** Makes the tables in a new file, and refuses one a newer muster made. */
export function ensureSchema(db: Db) {
  const read = () => whileBusy(() => (db.raw.prepare('pragma user_version').get() as { user_version: number }).user_version)
  const version = read()
  if (version > STORE_VERSION) {
    throw new Error(`store_too_new:${version}`)
  }
  if (version === STORE_VERSION) return
  whileBusy(() =>
    db.write(() => {
      // Another process may have made the tables while this one waited for the lock.
      if (read() === STORE_VERSION) return
      db.raw.exec(DDL)
      // A table made by an earlier version keeps its columns: add the ones it lacks.
      const columns = (db.raw.prepare('pragma table_info(links)').all() as { name: string }[]).map((column) => column.name)
      if (!columns.includes('place')) db.raw.exec('alter table links add column place text')
      db.raw.exec(`pragma user_version = ${STORE_VERSION}`)
    }),
  )
}

/** The tables a fold of the log rebuilds, for the fold test and for repair. */
export const DERIVED_TABLES = ['channels', 'messages', 'actors', 'idempotency', 'tasks', 'needs', 'schedules', 'slots', 'links', 'schemas', 'budgets'] as const
