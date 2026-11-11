SET LOCAL lock_timeout='2s';

-- Only fast defaults on existing tables. A folder belongs to the inbox, never to the
-- receiving address or credential: fan-out shares content, not UIDs, flags or state.
ALTER TABLE inbox_state ADD COLUMN modseq bigint NOT NULL DEFAULT 1, ADD COLUMN changes_floor bigint NOT NULL DEFAULT 0;
ALTER TABLE mailbox_messages ADD COLUMN modseq bigint, ADD COLUMN flags smallint NOT NULL DEFAULT 0;
CREATE TABLE inbox_folders (
 inbox_id text NOT NULL REFERENCES inbox_state ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('inbox','sent','junk','archive','trash')),
 uid_validity bigint NOT NULL DEFAULT (1+floor(random()*4294967295)::bigint),
 uid_next bigint NOT NULL DEFAULT 1, highest_modseq bigint NOT NULL DEFAULT 1,
 total int NOT NULL DEFAULT 0, unseen int NOT NULL DEFAULT 0,
 PRIMARY KEY(inbox_id,role)
);
CREATE TABLE inbox_entries (
 inbox_id text NOT NULL, role text NOT NULL, uid bigint NOT NULL CHECK(uid BETWEEN 1 AND 4294967295),
 message_id text NOT NULL, modseq bigint NOT NULL, deleted boolean NOT NULL DEFAULT false,
 internal_date timestamptz NOT NULL, PRIMARY KEY(inbox_id,role,uid),
 FOREIGN KEY(inbox_id,role) REFERENCES inbox_folders ON DELETE CASCADE,
 FOREIGN KEY(inbox_id,message_id) REFERENCES mailbox_messages(mailbox_id,message_id) ON DELETE CASCADE
);
CREATE INDEX inbox_entries_message ON inbox_entries(inbox_id,message_id);
CREATE INDEX inbox_entries_changes ON inbox_entries(inbox_id,modseq);
CREATE TABLE inbox_vanished (
 inbox_id text NOT NULL, role text NOT NULL, uid bigint NOT NULL, message_id text NOT NULL, modseq bigint NOT NULL,
 vanished_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(inbox_id,role,uid), FOREIGN KEY(inbox_id,role) REFERENCES inbox_folders ON DELETE CASCADE
);
CREATE INDEX inbox_vanished_changes ON inbox_vanished(inbox_id,modseq);
CREATE INDEX inbox_vanished_message ON inbox_vanished(inbox_id,message_id);
CREATE INDEX inbox_vanished_age ON inbox_vanished(vanished_at,inbox_id);

CREATE FUNCTION inbox_seed_folders(bid text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO inbox_folders(inbox_id,role) SELECT bid,unnest(ARRAY['inbox','sent','junk','archive','trash']) ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION inbox_new_folders() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM inbox_seed_folders(NEW.inbox_id); RETURN NULL; END $$;
CREATE TRIGGER inbox_new_folders AFTER INSERT ON inbox_state FOR EACH ROW EXECUTE FUNCTION inbox_new_folders();

-- Callers hold inbox_state until commit. COPY can make multiple entries even in the same
-- folder; the locator is (inbox,role,uid), not message_id. INTERNALDATE survives a move.
CREATE FUNCTION inbox_add_entry(bid text, mid text, dest text, stamp bigint, seen boolean, arrived timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE allocated bigint;
BEGIN
 UPDATE inbox_folders SET uid_next=uid_next+1,total=total+1,unseen=unseen+(NOT seen)::int,highest_modseq=stamp
 WHERE inbox_id=bid AND role=dest RETURNING uid_next-1 INTO STRICT allocated;
 INSERT INTO inbox_entries(inbox_id,role,uid,message_id,modseq,internal_date) VALUES(bid,dest,allocated,mid,stamp,arrived);
 RETURN allocated;
END $$;

CREATE FUNCTION inbox_file_delivery(bid text,mid text,delivery_seq bigint,legacy boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE membership mailbox_messages; stamp bigint; dest text; starred boolean; message_size int;
BEGIN
 PERFORM FROM inbox_state WHERE inbox_id=bid FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO membership FROM mailbox_messages WHERE mailbox_id=bid AND message_id=mid;
 IF NOT FOUND OR membership.modseq IS NOT NULL THEN RETURN; END IF;
 SELECT CASE WHEN legacy AND t.trashed_at IS NOT NULL THEN 'trash'
             WHEN membership.direction='outbound' THEN 'sent'
             WHEN (legacy AND t.spam) OR 'spam'=ANY(membership.labels) OR (m.spam AND NOT 'guard-allowed'=ANY(membership.labels)) THEN 'junk'
             WHEN legacy AND t.archived THEN 'archive' ELSE 'inbox' END,
        legacy AND coalesce(t.starred,false),coalesce(m.size_bytes,0) INTO dest,starred,message_size
 FROM mail_messages m LEFT JOIN mailbox_threads t ON t.mailbox_id=bid AND t.thread_id=m.thread_id WHERE m.id=mid;
 UPDATE inbox_state SET modseq=modseq+1,messages=messages+(membership.direction='outbound')::int,
   bytes=bytes+CASE WHEN membership.direction='outbound' THEN message_size ELSE 0 END WHERE inbox_id=bid RETURNING modseq INTO stamp;
 UPDATE mailbox_messages SET modseq=stamp,flags=CASE WHEN starred THEN 1 ELSE 0 END,
   inbox_seq=coalesce(inbox_seq,delivery_seq,nextval(pg_get_serial_sequence('mailbox_events','seq')))
 WHERE mailbox_id=bid AND message_id=mid;
 IF membership.held_reason IS NULL THEN
   -- A rolling deploy can deliver to an old inbox before its backfill page has run.
   IF NOT EXISTS(SELECT FROM inbox_folders WHERE inbox_id=bid AND role=dest) THEN PERFORM inbox_seed_folders(bid); END IF;
   PERFORM inbox_add_entry(bid,mid,dest,stamp,membership.read,membership.received_at);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION mail_inbox_cursor(wid text,published jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
 IF published IS NULL THEN RETURN; END IF;
 -- Store already locked all inbox states in ID order before publishing events.
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'events') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 FOR p IN SELECT * FROM jsonb_to_recordset(published) x(bid text,mid text,seq bigint) ORDER BY bid LOOP
   PERFORM inbox_file_delivery(p.bid,p.mid,p.seq);
 END LOOP;
END $$;

-- Same transaction as the outbound membership; retries that replay an existing send never
-- allocate a second UID. Ordinary sending addresses do not have an inbox_state row.
CREATE FUNCTION inbox_file_sent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM inbox_file_delivery(NEW.mailbox_id,NEW.message_id,NULL); RETURN NULL; END $$;
CREATE TRIGGER inbox_file_sent AFTER INSERT ON mailbox_messages FOR EACH ROW WHEN (NEW.direction='outbound') EXECUTE FUNCTION inbox_file_sent();

-- One inbox, at most 250 memberships per transaction, restartable without UID churn.
CREATE FUNCTION inbox_backfill_folders(cursor_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE pos jsonb:=nullif(cursor_key,'')::jsonb; bid text; after_mid text:=''; mid text; n int:=0;
BEGIN
 IF pos->>1 IS NOT NULL THEN bid:=pos->>0; after_mid:=pos->>1;
 ELSE SELECT inbox_id INTO bid FROM inbox_state WHERE inbox_id>coalesce(pos->>0,'') ORDER BY inbox_id LIMIT 1; END IF;
 IF bid IS NULL THEN RETURN NULL; END IF;
 PERFORM FROM inbox_state WHERE inbox_id=bid FOR UPDATE;
 IF FOUND THEN
   PERFORM inbox_seed_folders(bid);
   FOR mid IN SELECT message_id FROM mailbox_messages WHERE mailbox_id=bid AND message_id>after_mid ORDER BY message_id LIMIT 250 LOOP
     PERFORM inbox_file_delivery(bid,mid,NULL,true); n:=n+1; after_mid:=mid;
   END LOOP;
 END IF;
 RETURN jsonb_build_array(bid,CASE WHEN n=250 THEN after_mid END)::text;
END $$;
