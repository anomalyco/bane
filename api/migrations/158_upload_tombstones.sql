SET LOCAL lock_timeout='2s';

-- An attachment upload reserves quota, puts the object, then exchanges the reservation for the
-- attachment row. When the put outlasted the reservation, the sweeper took it and queued one
-- deletion. If that deletion ran before the put landed, and the Worker then died, or was an older
-- Worker whose refund queues nothing once the reservation is gone, no durable record remained. The
-- object leaked.
--
-- Every reservation that ends without its attachment now leaves a tombstone, recorded by trigger
-- so that every Worker version is covered. The reservation id is the attachment id, so publishing
-- (taking the reservation and inserting the attachment in one transaction) removes the tombstone
-- before it commits. A day later the hourly cleanup queues the object's deletion once more, unless
-- an attachment holds it.
--
-- No storage backend bounds when a put lands (an R2 binding put cannot be cancelled). So storage is
-- reconciled too, hourly: uploads are now stored under their own prefix, uploads/<workspace>/<attachment
-- id>, and the reconciler lists only that prefix, resuming from the cursor kept here, and queues the
-- deletion of any object of that exact grammar that nothing has referenced for a day. The prefix belongs
-- to uploads alone: every other key family starts with a workspace ID or a mail class (d, a, e, k),
-- and no workspace may be named uploads. (A workspace named attachments once made its kept mail,
-- k/attachments/msg_*.eml, look like an upload of a workspace k.) Objects stored under the earlier
-- layout, <workspace>/attachments/<id>, keep their tombstones and are not listed.
--
-- The deletion job rechecks every key when it runs, in one transaction with the delete:
-- storage_key_in_use finds any row that references the exact key, or the attachment, reservation or
-- template asset its last segment names. Mail rows reference this storage only through the local mail
-- store (bucket local:); R2 and S3 mail live in other buckets, and their keys (mail classes, .eml
-- objects, deeper paths) never match an attachment key's grammar. The lookups are indexed
-- (158_upload_key_indexes).
CREATE TABLE sending_upload_reconcile(id text PRIMARY KEY,after text NOT NULL);
ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_not_upload_prefix CHECK (id<>'uploads');
CREATE FUNCTION storage_key_in_use(k text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT FROM sending_attachments WHERE storage_key=k OR id=substring(k FROM '[^/]+$'))
  OR EXISTS(SELECT FROM sending_upload_reservations WHERE storage_key=k OR id=substring(k FROM '[^/]+$'))
  OR EXISTS(SELECT FROM template_assets WHERE storage_key=k OR id=substring(k FROM '[^/]+$'))
  OR EXISTS(SELECT FROM mail_messages WHERE raw_bucket='local:' AND raw_key=k)
  OR EXISTS(SELECT FROM mail_attachments WHERE bucket='local:' AND storage_key=k)
  OR EXISTS(SELECT FROM mail_candidate_uploads WHERE k=ANY(keys))
$$;
CREATE TABLE sending_upload_tombstones(id text PRIMARY KEY,workspace_id text NOT NULL,storage_key text NOT NULL,delete_after timestamptz NOT NULL);
CREATE INDEX sending_upload_tombstones_due ON sending_upload_tombstones(delete_after);

CREATE FUNCTION sending_upload_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sending_upload_tombstones VALUES(OLD.id,OLD.workspace_id,OLD.storage_key,now()+interval '24 hours') ON CONFLICT(id) DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER sending_upload_tombstone AFTER DELETE ON sending_upload_reservations FOR EACH ROW EXECUTE FUNCTION sending_upload_tombstone();

CREATE FUNCTION sending_upload_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM sending_upload_tombstones WHERE id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER sending_upload_published AFTER INSERT ON sending_attachments FOR EACH ROW EXECUTE FUNCTION sending_upload_published();
