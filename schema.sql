create table if not exists taken_logs (
  id bigint generated always as identity primary key,
  telegram_chat_id text not null,
  supplement_id text not null,
  taken_at timestamptz not null,
  reminder_sent_at timestamptz
);

create index if not exists taken_logs_chat_supplement
  on taken_logs (telegram_chat_id, supplement_id);

create index if not exists taken_logs_fin_due
  on taken_logs (taken_at)
  where supplement_id = 'fin' and reminder_sent_at is null;

create table if not exists loop_states (
  telegram_chat_id text primary key,
  next_supplement_id text not null,
  next_eligible_at timestamptz not null,
  reminder_sent_at timestamptz,
  updated_at timestamptz not null
);

create index if not exists loop_states_eligible
  on loop_states (next_eligible_at)
  where reminder_sent_at is null;

-- Fin doses use taken_logs with supplement_id = 'fin'.
-- Fin reminder timing is taken_at + 24h; reminder_sent_at on that row
-- records whether the ping was already sent. Vitamins ignore that column.

create table if not exists chat_ui_state (
  telegram_chat_id text primary key,
  last_options_message_ids bigint[] not null default '{}',
  updated_at timestamptz not null
);
