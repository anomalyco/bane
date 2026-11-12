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
-- an attachment holds it. Puts are bounded to ten minutes, far inside the hour-long reservation
-- and the tombstone's day.
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
