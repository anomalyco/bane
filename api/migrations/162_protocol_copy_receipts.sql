SET LOCAL lock_timeout='250ms';
CREATE TABLE mailgw_copy_receipts(
  kid text NOT NULL REFERENCES inbox_app_passwords(id) ON DELETE CASCADE,
  nonce text NOT NULL, issued bigint NOT NULL, request_hash text NOT NULL, answer jsonb NOT NULL,
  PRIMARY KEY(kid,nonce)
);
CREATE INDEX mailgw_copy_expiry ON mailgw_copy_receipts(issued);

-- Only signed, authenticated gateway requests reach this routine. Serialize
-- replay lookup, the UID allocations and the receipt under the normal inbox fence.
CREATE FUNCTION mailgw_copy_once(w text,b text,k text,src text,dst text,uids bigint[],nonce_ text,issued_ bigint,h text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE clock_s bigint; saved mailgw_copy_receipts; result jsonb;
BEGIN
  PERFORM FROM inbox_state WHERE workspace_id=w AND inbox_id=b FOR UPDATE;
  IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
  clock_s:=floor(extract(epoch FROM clock_timestamp()));
  IF issued_ NOT BETWEEN clock_s-300 AND clock_s+5 OR cardinality(uids)>1000 OR uids IS NULL THEN RETURN '{"error":"LIMIT"}'; END IF;
  SELECT * INTO saved FROM mailgw_copy_receipts WHERE kid=k AND nonce=nonce_;
  IF FOUND THEN
    IF saved.request_hash<>h OR saved.issued<>issued_ THEN RETURN '{"error":"CONFLICT"}'; END IF;
    RETURN saved.answer;
  END IF;
  DELETE FROM mailgw_copy_receipts WHERE ctid IN (SELECT ctid FROM mailgw_copy_receipts WHERE issued<clock_s-300 ORDER BY issued LIMIT 32 FOR UPDATE SKIP LOCKED);
  IF (SELECT count(*) FROM mailgw_copy_receipts WHERE kid=k AND issued>=clock_s-300)>=256 THEN RETURN '{"error":"LIMIT"}'; END IF;
  result:=mailgw_mutate(w,b,src,dst,'copy',uids,'add','{}','{}');
  INSERT INTO mailgw_copy_receipts VALUES(k,nonce_,issued_,h,result);
  RETURN result;
END $$;
