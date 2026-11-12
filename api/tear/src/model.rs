//! Reference model: idempotency reservations and grant revocation/ownership for one workspace.
//!
//! The model is written from the documented contract, not from the implementation: what a
//! retry, a concurrent duplicate, a revocation or an MCP listing *should* do. The host
//! (`../host.ts`) drives the real API; tear compares the two step by step.
//!
//! # Edge-case checklist
//!
//! Each item has an ID; `Model::tags` reports which items a transition exercises, and the runner
//! prints coverage against this list (reached, or the reason it is out of model).
//!
//! Idempotency reservations (`/v1/lists`, `/v1/api-keys`, `/v1/inboxes`; REST and MCP Code Mode)
//! - I1  same key, same body: replays the original (same id, `Idempotent-Replayed: true`).
//! - I2  same key, different body: 409 IDEMPOTENCY_CONFLICT.
//! - I3  secret-bearing create (API key): replay is 409 IDEMPOTENT_SECRET_WITHHELD; no response
//!       other than the first creation carries a secret.
//! - I4  key length 200 accepted; 201, empty and non-printable rejected (REST 422
//!       INVALID_IDEMPOTENCY_KEY; MCP INVALID_ARGUMENTS before any API call).
//! - I5  a failed create (4xx) releases its key; the same key may then succeed.
//! - I6  keys are scoped per credential: one key under two credentials is two creates.
//! - I7  authority change between attempts (receiving consent added) is a conflict, not a replay.
//! - I8  a provisioning inbox key retries its own inbox create (its visible inbox set grew).
//! - I9  MCP creates share the REST reservation table (replay through MCP).
//! - C1  concurrent duplicate while the winner runs: 409 IDEMPOTENCY_IN_PROGRESS (retryable).
//! - C2  concurrent duplicate after the winner recorded: replay.
//! - C3  concurrent duplicate whose lookup runs after the winner failed and released: retryable.
//! - C4  concurrent requests, one key, different bodies: 409 IDEMPOTENCY_CONFLICT.
//! - F1  crash after claim, before the handler: reservation stays pending; nothing created.
//! - F2  crash after the handler committed, before recording (lost result): no second create.
//! - F3  lost commit acknowledgement (handler committed, client saw ECONNRESET): no second create.
//! - F4  crash at release (handler failed, reservation not deleted): pending, nothing created.
//! - T1  pending reservation at age 599 999 ms: in progress; at 600 000 ms: outcome unknown.
//!
//! Revocation and ownership (REST, MCP Code Mode and plain MCP)
//! - R1  revoked API key (current `bane_` and legacy `os_live_`): REST denied; API keys never
//!       authorize MCP.
//! - R2  revoked agent token: denied; revoking it again is 404.
//! - R3  revoked MCP grant: both catalogs and tool calls denied, refresh denied; its agent tokens
//!       (v4 and legacy v3), API keys and inbox keys die with it.
//! - R4  member removed: the member's grant dies (listing, call, refresh).
//! - R5  member promoted: an existing member-capped grant does not widen; a grant approved after
//!       the promotion gets admin role (still bounded by its scopes).
//! - R6  inbox deleted: its bound key dies (REST and MCP).
//! - R7  a provisioning inbox key is independent of the API key that created it.
//! - R8  domain-restricted key: workspace audience reads are 403; it dies on revoke.
//! - R9  revoke before an in-flight request authenticates: that request is denied.
//! - R10 revoke after an in-flight request authenticated: the request linearizes before the
//!       revoke (it may finish); a derived credential it creates must not outlive the grant, and
//!       the refusal is an authorization error, not a 500.
//! - R11 agent token valid at exp-1 ms, invalid at exp; MCP access token likewise (5 minutes).
//! - R12 refresh restores access after access-token expiry only while the grant lives.
//! - R13 deploy overlap: credentials minted by an older release (`os_live_` keys, v3
//!       `os_agent_` tokens) are honored and revoked exactly like current ones.
//!
//! MCP listing versus REST authorization (sampled operations, see `SAMPLE`)
//! - M1  Code Mode listing equals REST authorization per actor (16 sampled operations): owner grant, owner grant with
//!       receiving consent, member-capped grant, admin grant, provisioning and bound inbox keys.
//! - M2  plain (resource tool) listing equals the same set.
//! - M3  a tool call from a grant has the REST status (getCurrentIdentity); non-MCP
//!       credentials (API keys, agent tokens) are refused by /mcp.
//!
//! Out of model (reported with the reason by `coverage`)
//! - X1  Worker/DB clock skew: the host stamps reservations with the Worker clock, so both agree.
//!       The 10-minute window compares `Date.now()` with the DB `created_at`; minutes of skew would
//!       move it. Real skew is NTP-bounded (milliseconds).
//! - X2  SES/R2/webhook partial failures: these creates make no external call; R2 is in-memory.
//!       Handler-level idempotency for sends, uploads, threads, campaigns and domains (with SES)
//!       is its own implementation and another area.
//! - X3  interleavings inside one SQL statement: checkpoints are statement-granular; Postgres
//!       serializes the two ON CONFLICT claims.
//! - X4  IMAP/SMTP sessions after revocation (gateway area); rate-limit budgets (admission area).
//! - X5  limits beyond the key length and expiry boundaries (body size, 50 domains, 20 inboxes)
//!       are validated by schemas outside this area.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const WINDOW: i64 = 600_000;
pub const TOKEN_TTL: i64 = 60_000;
pub const ACCESS_TTL_S: i64 = 300;

/// Sampled operations for the MCP-versus-REST check, in the host's reporting order.
pub const SAMPLE: [&str; 16] = [
    "getCurrentIdentity", "listContactLists", "createContactList", "createApiKey", "createAgentToken", "listInboxes",
    "createInbox", "getRouting", "listInboundKeys", "sendEmail", "deleteInbox", "replyToInboundThread",
    "listApiKeys", "listMcpConnections", "listDomains", "sendCampaign",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cred {
    pub revoked: bool,
    /// Expiry (ms, fixture clock) for agent tokens; 0 when the credential does not expire.
    pub exp: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Grant {
    pub revoked: bool,
    /// Access-token expiry (ms). The JWT `exp` is whole seconds.
    pub at: i64,
    /// Role the grant was approved under: owner, member (capped) or admin.
    pub role: String,
    /// The approval was re-consented (receiving added): refresh tokens issued for the previous
    /// reference no longer refresh. A reference never follows a user elsewhere.
    pub replaced: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Stored,
    Withheld,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Res {
    pub hash: String,
    pub outcome: Outcome,
    pub created: i64,
}

/// One idempotent create in flight, at a checkpoint.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Req {
    pub what: String,
    pub cred: String,
    pub key: String,
    pub body: String,
    pub lost: bool,
    pub at: String,
    /// Response the request will return when it reaches `release` or `record`.
    pub status: Option<i64>,
    pub code: Option<String>,
    pub outcome: Option<Outcome>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Model {
    pub t: i64,
    pub creds: BTreeMap<String, Cred>,
    pub grants: BTreeMap<String, Grant>,
    pub member: String,
    pub receiving: bool,
    pub box_deleted: bool,
    pub res: BTreeMap<String, Res>,
    /// Idempotency identities whose first successful create id the host has recorded.
    pub ids: BTreeMap<String, bool>,
    /// Identities whose reservation a failed create released at least once.
    pub released: std::collections::BTreeSet<String>,
    pub lists: i64,
    pub keys: i64,
    pub inboxes: i64,
    pub slots: BTreeMap<String, Req>,
}

/// Which alphabet to draw from: `Core` keeps BFS tractable, `Full` adds boundary keys and more
/// credential/operation combinations for random walks.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Alphabet {
    Core,
    Full,
    /// Two request slots racing on one idempotency key (with crashes, a lost ack and the window).
    Race,
    /// One in-flight request while its credential or grant is revoked.
    Revoke,
}

const REST_CREDS: [&str; 6] = ["key", "dkey", "legacy", "gkey", "token", "token3"];

impl Model {
    pub fn initial() -> Self {
        Model {
            t: 0, creds: BTreeMap::new(), grants: BTreeMap::new(), member: "member".into(), receiving: false, box_deleted: false,
            res: BTreeMap::new(), ids: BTreeMap::new(), released: Default::default(), lists: 0, keys: 0, inboxes: 0, slots: BTreeMap::new(),
        }
    }
    fn minted(&self, c: &str) -> bool {
        self.creds.contains_key(c)
    }
    /// The grant's authority: its consent exists and its user is still a member.
    fn grant_live(&self, g: &str) -> bool {
        self.grants.get(g).is_some_and(|x| !x.revoked) && (g != "grant2" || self.member != "removed")
    }
    fn access_ok(&self, g: &str) -> bool {
        self.grant_live(g) && self.t < self.grants[g].at
    }
    fn cred_live(&self, c: &str) -> bool {
        let Some(x) = self.creds.get(c) else { return false };
        if x.revoked {
            return false;
        }
        match c {
            "gkey" => self.grant_live("grant"),
            "token" | "token3" => self.grant_live("grant") && self.t < x.exp,
            "gikey" => self.grant_live("grant") && self.receiving,
            "bkey" => !self.box_deleted,
            _ => true,
        }
    }
    fn access_exp(t: i64) -> i64 {
        (t.div_euclid(1000) + ACCESS_TTL_S) * 1000
    }

    /// REST authorization of the sampled operations for an actor, in `SAMPLE` order.
    fn visible(&self, who: &str) -> Vec<&'static str> {
        let allow = |op: &str| -> bool {
            match who {
                "ikey" | "gikey" => matches!(op, "listInboxes" | "createInbox"),
                "bkey" => op == "listInboxes",
                _ => {
                    let g = &self.grants[who];
                    let manage = who == "grant";
                    let receiving = who == "grant" && self.receiving;
                    let member = g.role == "member";
                    match op {
                        "getCurrentIdentity" | "listContactLists" | "sendEmail" => true,
                        "createContactList" | "createApiKey" | "listInboxes" | "createInbox" | "deleteInbox"
                        | "replyToInboundThread" => manage,
                        "createAgentToken" | "listDomains" | "sendCampaign" => !member,
                        "getRouting" => receiving && !member,
                        "listInboundKeys" => receiving && manage,
                        "listApiKeys" => manage,
                        // Dashboard sessions only.
                        "listMcpConnections" => false,
                        _ => false,
                    }
                }
            }
        };
        SAMPLE.into_iter().filter(|op| allow(op)).collect()
    }

    // ---------- alphabet ----------
    fn focused(&self, alphabet: Alphabet) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        let race = alphabet == Alphabet::Race;
        let setup: &[&str] = if race { &["key"] } else { &["grant", "token"] };
        for c in setup {
            if !self.can_use(c) {
                return vec![format!("mint {c}")];
            }
        }
        let slots: &[&str] = if race { &["A", "B"] } else { &["A"] };
        for s in slots {
            if self.slots.contains_key(*s) {
                out.extend([format!("{s} step"), format!("{s} crash")]);
            } else if race {
                for b in ["b1", "b2", "bad", "b1 lost"] {
                    out.push(format!("{s} begin list key k1 {b}"));
                }
            } else {
                out.push(format!("{s} begin list token k1 b1"));
                if self.t < self.grants["grant"].at {
                    out.push(format!("{s} begin apikey grant k1 fixed"));
                }
            }
        }
        if race {
            out.push("create list key k1 b1".into());
            if let Some(r) = self.res.values().filter(|r| r.outcome == Outcome::Pending).map(|r| r.created).min() {
                for t in [r + WINDOW - 1, r + WINDOW] {
                    if t > self.t {
                        out.push(format!("tick {t}"));
                    }
                }
            }
        } else {
            out.extend(["revoke token", "revoke grant", "probe token rest"].map(String::from));
        }
        out
    }

    pub fn actions(&self, alphabet: Alphabet) -> Vec<String> {
        if matches!(alphabet, Alphabet::Race | Alphabet::Revoke) {
            return self.focused(alphabet);
        }
        let full = alphabet == Alphabet::Full;
        let mut out: Vec<String> = vec![];
        let mut push = |s: String| out.push(s);
        for c in ["key", "dkey", "legacy"] {
            if !self.minted(c) {
                push(format!("mint {c}"));
            } else {
                push(format!("revoke {c}"));
                push(format!("probe {c} rest"));
            }
        }
        if self.minted("dkey") {
            push("probe dkey lists".into());
        }
        if self.minted("key") {
            push("probe key mcp".into());
        }
        if !self.grants.contains_key("grant") {
            push("mint grant".into());
        } else {
            push("revoke grant".into());
            push("refresh grant".into());
            for how in ["code", "plain", "call"] {
                push(format!("probe grant {how}"));
            }
            if !self.receiving {
                push("receiving grant".into());
            }
            for c in ["token", "token3", "gkey", "gikey"] {
                if !self.minted(c) {
                    push(format!("mint {c}"));
                }
            }
        }
        for c in ["token", "token3", "gkey"] {
            if self.minted(c) {
                push(format!("revoke {c}"));
                push(format!("probe {c} rest"));
            }
        }
        if self.minted("token") {
            push("probe token mcp".into());
        }
        if self.member != "removed" {
            if !self.grants.contains_key("grant2") {
                push("mint grant2".into());
            }
            push("remove member".into());
            if self.member == "member" {
                push("promote member".into());
            }
        }
        if self.grants.contains_key("grant2") {
            push("revoke grant2".into());
            push("refresh grant2".into());
            for how in ["code", "plain", "call"] {
                push(format!("probe grant2 {how}"));
            }
        }
        if self.minted("key") {
            for c in ["ikey", "box"] {
                if !self.minted(if c == "box" { "bkey" } else { c }) {
                    push(format!("mint {c}"));
                }
            }
        }
        for c in ["ikey", "gikey"] {
            if self.minted(c) {
                push(format!("revoke {c}"));
                push(format!("probe {c} rest"));
                push(format!("probe {c} mcp"));
            }
        }
        if self.minted("bkey") {
            push("delete box".into());
            push("probe bkey rest".into());
            push("probe bkey mcp".into());
        }
        // Idempotent creates.
        let creds_list: &[&str] = if full { &["key", "grant", "token", "dkey", "legacy"] } else { &["key", "grant"] };
        let keys: &[&str] = if full { &["k1", "k2", "kmax", "klong", "kbad", "kempty"] } else { &["k1", "k2"] };
        for &c in creds_list {
            if !self.can_use(c) {
                continue;
            }
            for &k in keys {
                for b in ["b1", "b2", "bad"] {
                    if !full && k == "k2" && b != "b1" {
                        continue;
                    }
                    push(format!("create list {c} {k} {b}"));
                }
            }
        }
        if !full {
            for k in ["kmax", "klong", "kempty"] {
                if self.can_use("key") {
                    push(format!("create list key {k} b1"));
                }
            }
        }
        for c in ["key", "grant", "token"] {
            if self.can_use(c) {
                push(format!("create apikey {c} k1"));
            }
        }
        for c in ["ikey", "key"] {
            if self.can_use(c) {
                push(format!("create inbox {c} k1"));
            }
        }
        for (what, c) in [("list", "key"), ("list", "grant"), ("apikey", "key"), ("inbox", "ikey")] {
            if self.can_use(c) && (full || what != "apikey") {
                push(format!("lost {what} {c} k1 b1"));
            }
        }
        // Concurrency: two slots.
        for s in ["A", "B"] {
            match self.slots.get(s) {
                Some(r) => {
                    let _ = r;
                    push(format!("{s} step"));
                    push(format!("{s} crash"));
                }
                None => {
                    let mut begins: Vec<String> = vec![];
                    for b in ["b1", "b2", "bad"] {
                        if self.can_use("key") {
                            begins.push(format!("list key k1 {b}"));
                        }
                    }
                    if self.can_use("key") {
                        begins.push("list key k1 b1 lost".into());
                    }
                    if self.can_use("grant") && self.t < self.grants["grant"].at {
                        begins.push("list grant k1 b1".into());
                        begins.push("apikey grant k1 fixed".into());
                    }
                    if self.can_use("token") {
                        begins.push("list token k1 b1".into());
                    }
                    if full && self.can_use("ikey") {
                        begins.push("inbox ikey k1 fixed".into());
                    }
                    for b in begins {
                        push(format!("{s} begin {b}"));
                    }
                }
            }
        }
        // Clock boundaries the model can name exactly.
        let mut ticks: Vec<i64> = vec![];
        if let Some(r) = self.res.values().filter(|r| r.outcome == Outcome::Pending).map(|r| r.created).min() {
            ticks.extend([r + WINDOW - 1, r + WINDOW]);
        }
        for c in ["token", "token3"] {
            if let Some(x) = self.creds.get(c) {
                ticks.extend([x.exp - 1, x.exp]);
            }
        }
        if let Some(g) = self.grants.get("grant") {
            ticks.extend([g.at - 1, g.at]);
        }
        ticks.sort_unstable();
        ticks.dedup();
        for t in ticks.into_iter().filter(|&t| t > self.t) {
            push(format!("tick {t}"));
        }
        out
    }
    /// Whether the host holds a secret for this credential (it was minted).
    fn can_use(&self, c: &str) -> bool {
        match c {
            "grant" | "grant2" => self.grants.contains_key(c),
            _ => self.minted(c),
        }
    }
    /// Every focused alphabet is a subset of the full one.
    pub fn enabled(&self, action: &str) -> bool {
        self.actions(Alphabet::Full).iter().any(|a| a == action)
    }

    // ---------- transitions ----------
    pub fn step(&mut self, action: &str) -> Value {
        let w: Vec<&str> = action.split(' ').collect();
        match w[0] {
            "mint" => self.mint(w[1]),
            "revoke" => self.revoke(w[1]),
            "delete" => {
                let status = if self.box_deleted { 404 } else { 202 };
                self.box_deleted = true;
                json!({"status": status})
            }
            "receiving" => {
                self.receiving = true;
                self.grants.get_mut("grant").unwrap().replaced = true;
                json!({})
            }
            "refresh" => {
                if self.grant_live(w[1]) && !self.grants[w[1]].replaced {
                    let t = self.t;
                    self.grants.get_mut(w[1]).unwrap().at = Self::access_exp(t);
                    json!({"status": "ok"})
                } else {
                    json!({"status": "denied"})
                }
            }
            "remove" => {
                self.member = "removed".into();
                json!({"status": 200})
            }
            "promote" => {
                self.member = "admin".into();
                json!({"status": 200})
            }
            "probe" => self.probe(w[1], w[2]),
            "tick" => {
                self.t = w[1].parse().unwrap();
                json!({})
            }
            "create" | "lost" => {
                let mut req = Req {
                    what: w[1].into(), cred: w[2].into(), key: w[3].into(), body: w.get(4).copied().unwrap_or("b1").into(),
                    lost: w[0] == "lost", at: "start".into(), status: None, code: None, outcome: None,
                };
                loop {
                    if let Some(done) = self.advance(&mut req) {
                        return done;
                    }
                }
            }
            "A" | "B" => {
                let slot = w[0];
                match w[1] {
                    "begin" => {
                        let mut req = Req {
                            what: w[2].into(), cred: w[3].into(), key: w[4].into(), body: w[5].into(), lost: w.get(6) == Some(&"lost"),
                            at: "start".into(), status: None, code: None, outcome: None,
                        };
                        match self.advance(&mut req) {
                            Some(done) => with_at(done),
                            None => {
                                let at = req.at.clone();
                                self.slots.insert(slot.into(), req);
                                json!({"at": at})
                            }
                        }
                    }
                    "step" => {
                        let mut req = self.slots.remove(slot).unwrap();
                        match self.advance(&mut req) {
                            Some(done) => with_at(done),
                            None => {
                                let at = req.at.clone();
                                self.slots.insert(slot.into(), req);
                                json!({"at": at})
                            }
                        }
                    }
                    _ => {
                        // crash: the parked statement never runs; nothing after it happens.
                        self.slots.remove(slot);
                        json!({"crashed": true})
                    }
                }
            }
            _ => panic!("unknown action {action}"),
        }
    }

    fn mint(&mut self, c: &str) -> Value {
        let t = self.t;
        let via_grant = |m: &Self| if m.access_ok("grant") { None } else { Some(json!({"status": 401, "code": null})) };
        match c {
            "key" | "dkey" | "legacy" => {
                self.creds.insert(c.into(), Cred::default());
                self.keys += 1;
                json!({"status": 201})
            }
            "grant" | "grant2" => {
                let role = if c == "grant" { "owner".to_string() } else { self.member.clone() };
                self.grants.insert(c.into(), Grant { revoked: false, at: Self::access_exp(t), role, replaced: false });
                json!({"status": "ok"})
            }
            "token" => {
                if let Some(denied) = via_grant(self) {
                    return denied;
                }
                self.creds.insert(c.into(), Cred { revoked: false, exp: t + TOKEN_TTL });
                json!({"status": 201, "code": null})
            }
            "token3" => {
                self.creds.insert(c.into(), Cred { revoked: false, exp: t + TOKEN_TTL });
                json!({"status": 201})
            }
            "gkey" => {
                if let Some(denied) = via_grant(self) {
                    return denied;
                }
                self.creds.insert(c.into(), Cred::default());
                self.keys += 1;
                json!({"status": 201, "code": null})
            }
            "gikey" => {
                if let Some(denied) = via_grant(self) {
                    return denied;
                }
                if !self.receiving {
                    return json!({"status": null, "code": "TOOL_UNAVAILABLE"});
                }
                self.creds.insert(c.into(), Cred::default());
                json!({"status": 201, "code": null})
            }
            "ikey" | "box" => {
                if !self.cred_live("key") {
                    return json!({"status": 401, "code": "AUTH_INVALID"});
                }
                if c == "box" {
                    self.inboxes += 1;
                    self.creds.insert("bkey".into(), Cred::default());
                } else {
                    self.creds.insert(c.into(), Cred::default());
                }
                json!({"status": 201, "code": null})
            }
            _ => panic!("mint {c}"),
        }
    }

    fn revoke(&mut self, c: &str) -> Value {
        match c {
            "grant" | "grant2" => {
                let g = self.grants.get_mut(c).unwrap();
                let status = if g.revoked { 404 } else { 200 };
                g.revoked = true;
                if c == "grant" {
                    for d in ["token", "token3", "gkey", "gikey"] {
                        if let Some(x) = self.creds.get_mut(d) {
                            x.revoked = true;
                        }
                    }
                }
                json!({"status": status})
            }
            _ => {
                let x = self.creds.get_mut(c).unwrap();
                // API keys answer 200 to a repeated revoke; agent tokens and inbox keys answer 404.
                let api_key = matches!(c, "key" | "dkey" | "legacy" | "gkey");
                let status = if x.revoked && !api_key { 404 } else { 200 };
                x.revoked = true;
                json!({"status": status})
            }
        }
    }

    fn probe(&self, who: &str, how: &str) -> Value {
        match (who, how) {
            ("grant" | "grant2", "call") => {
                if self.access_ok(who) { json!({"status": 200, "code": null}) } else { json!({"status": 401, "code": null}) }
            }
            ("grant" | "grant2", _) => {
                if self.access_ok(who) { json!({"status": 200, "visible": self.visible(who)}) } else { json!({"status": 401}) }
            }
            (_, "mcp") if REST_CREDS.contains(&who) => json!({"status": 401}),
            (_, "mcp") => {
                if self.cred_live(who) { json!({"status": 200, "visible": self.visible(who)}) } else { json!({"status": 401}) }
            }
            ("dkey", "lists") => {
                if self.cred_live(who) {
                    json!({"status": 403, "code": "UNRESTRICTED_KEY_REQUIRED"})
                } else {
                    json!({"status": 401, "code": "AUTH_INVALID"})
                }
            }
            _ => json!({"status": if self.cred_live(who) { 200 } else { 401 }}),
        }
    }

    // ---------- one idempotent create, one checkpoint at a time ----------
    fn identity(r: &Req) -> String {
        format!("{}|{}|{}", r.what, r.cred, r.key)
    }
    fn hash(&self, r: &Req) -> String {
        let body = if r.what == "list" { r.body.as_str() } else { "fixed" };
        // The request's authority is part of its identity: a grant's receiving consent is. A
        // provisioning key's own creations are not.
        let authority = if r.cred == "grant" && self.receiving { "receiving" } else { "-" };
        format!("{body}|{authority}")
    }
    fn mcp(r: &Req) -> bool {
        r.cred == "grant"
    }
    fn count(&self, what: &str) -> (&'static str, i64) {
        match what {
            "list" => ("lists", self.lists),
            "apikey" => ("keys", self.keys),
            _ => ("inboxes", self.inboxes),
        }
    }
    fn done(&mut self, r: &Req, status: Option<i64>, code: Option<&str>, replay: bool) -> Value {
        let mcp = Self::mcp(r);
        let success = status.is_some_and(|s| s < 300);
        let id = Self::identity(r);
        let same = if success {
            if self.ids.contains_key(&id) { json!(true) } else {
                self.ids.insert(id, true);
                Value::Null
            }
        } else {
            Value::Null
        };
        let same = if replay { json!(true) } else { same };
        let secret = success && !replay && r.what == "apikey";
        let (name, n) = self.count(&r.what);
        let mut v = json!({"status": status, "code": code, "replayed": if mcp { Value::Null } else { json!(replay) }, "same": same, "secret": secret});
        v[name] = json!(n);
        v
    }
    fn key_valid(k: &str) -> bool {
        !matches!(k, "klong" | "kbad" | "kempty")
    }
    /// The database-side authorization at the auth checkpoint. An agent token's expiry was already
    /// checked before the request touched the database (at `start`), so it is not rechecked here:
    /// a request linearizes at its start.
    fn auth_ok(&self, r: &Req) -> bool {
        if Self::mcp(r) {
            return self.access_ok("grant");
        }
        match r.cred.as_str() {
            "token" | "token3" => self.creds.get(&r.cred).is_some_and(|x| !x.revoked) && self.grant_live("grant"),
            c => self.cred_live(c),
        }
    }

    /// Run the request's current checkpoint against the model's state. Returns the final
    /// observation when the request completes, else leaves it parked at the next checkpoint.
    fn advance(&mut self, r: &mut Req) -> Option<Value> {
        let mcp = Self::mcp(r);
        match r.at.as_str() {
            "start" => {
                // An expired agent token is refused before any database work.
                if matches!(r.cred.as_str(), "token" | "token3") && self.creds.get(&r.cred).is_some_and(|x| self.t >= x.exp) {
                    let r = r.clone();
                    return Some(self.done(&r, Some(401), Some("AUTH_INVALID"), false));
                }
                r.at = "auth".into();
                None
            }
            "auth" => {
                let r0 = r.clone();
                if !self.auth_ok(r) {
                    return Some(if mcp { self.done(&r0, Some(401), None, false) } else { self.done(&r0, Some(401), Some("AUTH_INVALID"), false) });
                }
                if r.what == "list" && r.cred == "dkey" {
                    return Some(self.done(&r0, Some(403), Some("UNRESTRICTED_KEY_REQUIRED"), false));
                }
                if !Self::key_valid(&r.key) || (mcp && r.body == "bad") {
                    return Some(if mcp { self.done(&r0, None, Some("INVALID_ARGUMENTS"), false) } else { self.done(&r0, Some(422), Some("INVALID_IDEMPOTENCY_KEY"), false) });
                }
                r.at = "claim".into();
                None
            }
            "claim" => {
                let id = Self::identity(r);
                if self.res.contains_key(&id) {
                    r.at = "lookup".into();
                    return None;
                }
                self.res.insert(id, Res { hash: self.hash(r), outcome: Outcome::Pending, created: self.t });
                let (fail, handler) = match (r.what.as_str(), r.cred.as_str(), r.body.as_str()) {
                    ("list", _, "bad") => (Some((422, "VALIDATION_FAILED")), false),
                    ("apikey", "token", _) => (Some((403, "CREDENTIAL_DELEGATION_FORBIDDEN")), false),
                    _ => (None, true),
                };
                if let Some((s, c)) = fail {
                    r.status = Some(s);
                    r.code = Some(c.into());
                }
                r.at = if handler { "handler" } else { "release" }.into();
                None
            }
            "handler" => {
                // A grant-derived API key cannot outlive the grant: once the grant is gone the
                // create is refused as unauthorized.
                if r.what == "apikey" && r.cred == "grant" && !self.grant_live("grant") {
                    r.status = Some(401);
                    r.code = Some("AUTH_INVALID".into());
                    r.at = "release".into();
                    return None;
                }
                match r.what.as_str() {
                    "list" => self.lists += 1,
                    "apikey" => self.keys += 1,
                    _ => self.inboxes += 1,
                }
                if r.lost {
                    // The commit happened; the client cannot know. The key must not run again.
                    r.status = Some(503);
                    r.code = Some("DATABASE_UNAVAILABLE".into());
                    r.outcome = Some(Outcome::Unknown);
                } else {
                    r.status = Some(201);
                    r.outcome = Some(if r.what == "apikey" { Outcome::Withheld } else { Outcome::Stored });
                }
                r.at = "record".into();
                None
            }
            "record" => {
                let id = Self::identity(r);
                if let Some(x) = self.res.get_mut(&id) {
                    x.outcome = r.outcome.clone().unwrap();
                }
                let r = r.clone();
                Some(self.done(&r, r.status, r.code.as_deref(), false))
            }
            "release" => {
                self.res.remove(&Self::identity(r));
                self.released.insert(Self::identity(r));
                let r = r.clone();
                Some(self.done(&r, r.status, r.code.as_deref(), false))
            }
            "lookup" => {
                let id = Self::identity(r);
                let r0 = r.clone();
                let hash = self.hash(r);
                let conflict = |m: &mut Self, code: &str| Some(m.done(&r0, Some(409), Some(code), false));
                match self.res.get(&id).cloned() {
                    // The winner failed and released between our claim and lookup: retry.
                    None => conflict(self, "IDEMPOTENCY_IN_PROGRESS"),
                    Some(x) if x.hash != hash => conflict(self, "IDEMPOTENCY_CONFLICT"),
                    Some(x) => match x.outcome {
                        Outcome::Pending if self.t - x.created >= WINDOW => conflict(self, "IDEMPOTENCY_OUTCOME_UNKNOWN"),
                        Outcome::Pending => conflict(self, "IDEMPOTENCY_IN_PROGRESS"),
                        Outcome::Unknown => conflict(self, "IDEMPOTENCY_OUTCOME_UNKNOWN"),
                        Outcome::Withheld => conflict(self, "IDEMPOTENT_SECRET_WITHHELD"),
                        Outcome::Stored => Some(self.done(&r0, Some(201), None, true)),
                    },
                }
            }
            other => panic!("bad checkpoint {other}"),
        }
    }

    /// Checklist items this transition exercises (for coverage reporting). `self` is the state
    /// before the transition.
    pub fn tags(&self, action: &str, observed: &Value) -> Vec<&'static str> {
        let w: Vec<&str> = action.split(' ').collect();
        let mut t = vec![];
        let code = observed["code"].as_str().unwrap_or_default();
        let at = observed["at"].as_str().unwrap_or_default();
        let replay = observed["same"] == json!(true);
        let done = matches!(w[0], "create" | "lost") || (matches!(w[0], "A" | "B") && at == "done");
        let req = match w[0] {
            "create" | "lost" => Some(Req { what: w[1].into(), cred: w[2].into(), key: w[3].into(), body: w.get(4).copied().unwrap_or("b1").into(), lost: w[0] == "lost", at: "start".into(), status: None, code: None, outcome: None }),
            "A" | "B" if w[1] == "begin" => Some(Req { what: w[2].into(), cred: w[3].into(), key: w[4].into(), body: w[5].into(), lost: w.get(6) == Some(&"lost"), at: "start".into(), status: None, code: None, outcome: None }),
            "A" | "B" => self.slots.get(w[0]).cloned(),
            _ => None,
        };
        if let (true, Some(r)) = (done, &req) {
            let id = Self::identity(r);
            if replay {
                t.push("I1");
            }
            if code == "IDEMPOTENCY_CONFLICT" {
                t.push("I2");
            }
            if code == "IDEMPOTENT_SECRET_WITHHELD" || (r.what == "apikey" && observed["secret"] == json!(true)) {
                t.push("I3");
            }
            if matches!(code, "INVALID_IDEMPOTENCY_KEY" | "INVALID_ARGUMENTS") || r.key == "kmax" {
                t.push("I4");
            }
            if observed["status"].as_i64().is_some_and(|s| s < 300) && !replay && self.released.contains(&id) {
                t.push("I5");
            }
            if self.res.keys().any(|k| { let p: Vec<&str> = k.split('|').collect(); p[0] == r.what && p[2] == r.key && p[1] != r.cred }) {
                t.push("I6");
            }
            if r.cred == "grant" && self.receiving && self.res.get(&id).is_some_and(|x| !x.hash.ends_with("receiving")) {
                t.push("I7");
            }
            if r.what == "inbox" && r.cred == "ikey" && replay {
                t.push("I8");
            }
            if r.cred == "grant" && (replay || code.starts_with("IDEMPOTEN")) {
                t.push("I9");
            }
            if r.lost {
                t.push("F3");
            }
            if let Some(x) = self.res.get(&id).filter(|x| x.outcome == Outcome::Pending) {
                if matches!(self.t - x.created, a if a == WINDOW - 1 || a == WINDOW) {
                    t.push("T1");
                }
            }
        }
        if matches!(w[0], "A" | "B") && w[1] != "begin" {
            if let Some(r) = &req {
                let id = Self::identity(r);
                let other = self.slots.iter().any(|(k, o)| k != w[0] && Self::identity(o) == id);
                match (w[1], r.at.as_str()) {
                    ("step", "lookup") => match self.res.get(&id) {
                        None => t.push("C3"),
                        Some(x) if x.hash != self.hash(r) => t.push(if other { "C4" } else { "I2" }),
                        Some(x) if x.outcome == Outcome::Pending && other => t.push("C1"),
                        Some(x) if x.outcome == Outcome::Stored => t.push("C2"),
                        _ => {}
                    },
                    ("step", "auth") if !self.auth_ok(r) => t.push("R9"),
                    ("step", "claim" | "handler" | "record" | "release") if !self.auth_ok(r) => t.push("R10"),
                    ("crash", "handler") => t.push("F1"),
                    ("crash", "record") => t.push("F2"),
                    ("crash", "release") => t.push("F4"),
                    _ => {}
                }
            }
        }
        match (w[0], w.get(1).copied().unwrap_or_default(), w.get(2).copied().unwrap_or_default()) {
            ("probe", "key" | "token", "mcp") => t.push("M3"),
            ("probe", "key", _) if observed["status"] == 401 => t.push("R1"),
            ("probe", "token", _) if observed["status"] == 401 && self.creds["token"].revoked => t.push("R2"),
            ("probe", "gkey" | "gikey" | "token" | "token3", _) | ("probe", "grant", "code" | "plain" | "call")
                if observed["status"] == 401 && self.grants.get("grant").is_some_and(|g| g.revoked) => t.push("R3"),
            ("probe", "legacy" | "token3", _) => t.push("R13"),
            ("probe", "grant2", _) if observed["status"] == 401 && self.member == "removed" => t.push("R4"),
            ("probe", "grant2", _) if self.member == "admin" => t.push("R5"),
            ("probe", "bkey", _) if self.box_deleted => t.push("R6"),
            ("probe", "ikey", _) if self.creds.get("key").is_some_and(|k| k.revoked) && observed["status"] == 200 => t.push("R7"),
            ("probe", "dkey", _) => t.push("R8"),
            ("revoke", "token" | "token3", _) if observed["status"] == 404 => t.push("R2"),
            ("refresh", _, _) => t.push("R12"),
            _ => {}
        }
        if w[0] == "probe" && matches!(w[2], "code" | "mcp") && observed["visible"].is_array() {
            t.push("M1");
        }
        if w[0] == "probe" && w[2] == "plain" && observed["visible"].is_array() {
            t.push("M2");
        }
        if w[0] == "probe" && w[2] == "call" {
            t.push("M3");
        }
        if w[0] == "tick" {
            let n: i64 = w[1].parse().unwrap_or_default();
            if self.creds.values().any(|c| c.exp != 0 && (n == c.exp - 1 || n == c.exp)) || self.grants.values().any(|g| n == g.at - 1 || n == g.at) {
                t.push("R11");
            }
        }
        t
    }
}

fn with_at(mut v: Value) -> Value {
    v["at"] = json!("done");
    v
}

pub const CHECKLIST: [(&str, &str); 37] = [
    ("I1", "same key, same body replays the original"), ("I2", "same key, different body: 409 conflict"),
    ("I3", "secret-bearing create replay withheld; no secret replayed"), ("I4", "key length 200/201, empty, non-printable"),
    ("I5", "a failed create releases its key"), ("I6", "keys are scoped per credential"),
    ("I7", "authority change between attempts is a conflict"), ("I8", "provisioning inbox key retries its own create"),
    ("I9", "MCP creates share REST reservations"), ("C1", "concurrent duplicate while the winner runs"),
    ("C2", "concurrent duplicate after the winner recorded"), ("C3", "duplicate lookup after the winner released"),
    ("C4", "concurrent different bodies, one key"), ("F1", "crash after claim, before the handler"),
    ("F2", "crash after commit, before record"), ("F3", "lost commit acknowledgement"),
    ("F4", "crash at release"), ("T1", "reservation age 599 999 / 600 000 ms"),
    ("R1", "revoked API key denied; API keys never authorize MCP"), ("R2", "revoked agent token; re-revoke 404"),
    ("R3", "revoked grant: catalogs, calls, refresh and derived credentials die"), ("R4", "member removed: member grant dies"),
    ("R5", "member promoted: capped grant does not widen"), ("R6", "inbox deleted: bound key dies"),
    ("R7", "provisioning key independent of its creating key"), ("R8", "domain-restricted key"),
    ("R9", "revoke before an in-flight request authenticates"), ("R10", "revoke after an in-flight request authenticated"),
    ("R11", "token and access-token expiry boundaries"), ("R12", "refresh only while the grant lives"),
    ("R13", "deploy overlap: os_live_ keys and v3 tokens"), ("M1", "Code Mode listing equals REST authorization"),
    ("M2", "plain listing equals the same set"), ("M3", "tool call status; non-MCP credentials refused by /mcp"),
    ("X1", "out of model: Worker/DB clock skew (host pins both clocks; NTP-bounded in production)"),
    ("X2", "out of model: SES/R2/webhook failures (these creates make no external call)"),
    ("X3", "out of model: interleavings inside one SQL statement (statement-granular checkpoints)"),
];
