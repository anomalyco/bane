SET LOCAL lock_timeout='2s';
-- The existing (inbox_id,role) locator is immutable. Keep all old PK/FKs, UIDs and
-- UIDVALIDITY values; for custom folders only, role holds an opaque ID, never a path.
-- No existing row needs rewriting. Install the seed trigger before backfilling Drafts.
ALTER TABLE inbox_folders DROP CONSTRAINT inbox_folders_role_check,
 ADD COLUMN custom_path text, ADD COLUMN subscribed boolean NOT NULL DEFAULT true,
 ADD CONSTRAINT inbox_folder_kind CHECK ((role IN ('inbox','sent','drafts','junk','archive','trash') AND custom_path IS NULL) OR (role ~ '^fld_[0-9a-f]{32}$' AND custom_path IS NOT NULL)) NOT VALID;
CREATE SEQUENCE inbox_custom_validity AS bigint MAXVALUE 4294967295 NO CYCLE;
CREATE OR REPLACE FUNCTION inbox_seed_folders(bid text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO inbox_folders(inbox_id,role) SELECT bid,unnest(ARRAY['inbox','sent','drafts','junk','archive','trash']) ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION inbox_folder_path(f inbox_folders) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(f.custom_path,CASE WHEN f.role='inbox' THEN 'INBOX' ELSE initcap(f.role) END)
$$;

-- Match dev 151: a join in the locking statement retains its pre-wait mailbox
-- snapshot. Check visibility in a separate statement after taking the fence.
CREATE FUNCTION inbox_lock_visible(w text,b text,persistent boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM FROM inbox_state WHERE workspace_id=w AND inbox_id=b FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN EXISTS(SELECT FROM mailboxes WHERE workspace_id=w AND id=b AND kind='inbox' AND
   (delete_after IS NULL OR delete_after>statement_timestamp()) AND
   (NOT persistent OR (delete_after IS NULL AND retention_mode='forever')));
END $$;

-- Same inbox_state fence as ingest and inbox_mutate. Serializes create/rename path
-- checks, entry removal, subscription and the folder delta with every other writer.
CREATE FUNCTION inbox_edit_folder(wid text,bid text,op text,fid text,p text,sub boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f inbox_folders; made text; stamp bigint; item record; prefix text;
BEGIN
 IF NOT inbox_lock_visible(wid,bid) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 IF op IN ('create','rename') AND (p IS NULL OR octet_length(p) NOT BETWEEN 1 AND 255 OR p ~ '[[:cntrl:]]|(^/|/$|//)' OR cardinality(string_to_array(p,'/'))>8 OR lower(p) IN ('inbox','sent','drafts','junk','archive','trash')) THEN RETURN '{"error":"INVALID_PATH"}'; END IF;
 IF op<>'create' THEN SELECT * INTO f FROM inbox_folders WHERE inbox_id=bid AND role=fid; IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF; END IF;
 IF op IN ('create','rename') AND EXISTS(SELECT FROM inbox_folders WHERE inbox_id=bid AND custom_path=p) THEN RETURN '{"error":"ALREADYEXISTS"}'; END IF;
 IF op='create' THEN
  IF (SELECT count(*) FROM inbox_folders WHERE inbox_id=bid)>=200 THEN RETURN '{"error":"FOLDER_LIMIT"}'; END IF;
  made:='fld_'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO inbox_folders(inbox_id,role,custom_path,subscribed,uid_validity) VALUES(bid,made,p,false,nextval('inbox_custom_validity')) RETURNING * INTO f;
 ELSIF op='subscribe' THEN UPDATE inbox_folders SET subscribed=sub WHERE inbox_id=bid AND role=fid RETURNING * INTO f;
 ELSIF f.custom_path IS NULL THEN RETURN '{"error":"PROTECTED_FOLDER"}';
 ELSIF op='rename' THEN
  prefix:=f.custom_path||'/'; IF starts_with(p,prefix) THEN RETURN '{"error":"INVALID_PATH"}'; END IF;
  IF EXISTS(SELECT FROM inbox_folders c WHERE c.inbox_id=bid AND starts_with(c.custom_path,prefix) AND (octet_length(p||substr(c.custom_path,length(f.custom_path)+1))>255 OR cardinality(string_to_array(p||substr(c.custom_path,length(f.custom_path)+1),'/'))>8 OR EXISTS(SELECT FROM inbox_folders d WHERE d.inbox_id=bid AND d.custom_path=p||substr(c.custom_path,length(f.custom_path)+1) AND NOT starts_with(d.custom_path,prefix)))) THEN RETURN '{"error":"INVALID_PATH"}'; END IF;
  UPDATE inbox_folders SET custom_path=p||substr(custom_path,length(f.custom_path)+1) WHERE inbox_id=bid AND (role=fid OR starts_with(custom_path,prefix));
 ELSIF op='delete' THEN
  FOR item IN SELECT * FROM inbox_entries WHERE inbox_id=bid AND role=fid ORDER BY uid LOOP
   -- Preserve the last membership in Trash, rather than orphaning it via FK cascade.
   PERFORM inbox_mutate(wid,bid,item.message_id,CASE WHEN EXISTS(SELECT FROM inbox_entries WHERE inbox_id=bid AND message_id=item.message_id AND (role,uid)<>(fid,item.uid)) THEN 'expunge' ELSE 'move' END,jsonb_build_object('source',fid,'uid',item.uid,'folder','trash'));
  END LOOP;
  DELETE FROM inbox_folders WHERE inbox_id=bid AND role=fid;
 ELSE RETURN '{"error":"INVALID_OP"}'; END IF;
 UPDATE inbox_state SET modseq=modseq+1,changes_floor=CASE WHEN op='delete' THEN modseq+1 ELSE changes_floor END WHERE inbox_id=bid RETURNING modseq INTO stamp;
 RETURN jsonb_build_object('id',f.role,'state',stamp::text);
END $$;
