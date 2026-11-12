#!/usr/bin/env python3
"""One-command loopback acceptance gate. No production addresses, credentials or delivery."""

import base64
import hashlib
import hmac
import urllib.request
import contextlib
from concurrent.futures import ThreadPoolExecutor
import imaplib
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import smtplib
import socket
import ssl
import subprocess as sp
import sys
import tempfile
import time
import traceback

ROOT = Path(__file__).resolve().parent
USER = "primary@example.invalid"
ALIAS = "alias@example.invalid"
PASS = secrets.token_hex(12)
RAW = b"From: alias@example.invalid\r\nSubject: caf\xc3\xa9\r\nMessage-ID: <one@example.invalid>\r\nContent-Type: text/plain\r\n\r\n.dot\r\n"
IMAPTEST = "dovecot/imaptest@sha256:db2b7de2f7bdd5d331fbdc12463828e3e35f1571c40999df47a0ff2359d399d7"
DOVECOT = "dovecot/dovecot@sha256:547d28f9a893c93a1d2f6dc164880cd7bfa74009106dfa46b36a6a2ee636d921"
SCRIPTS = "0682be5f3617149e55cb6a2f4de4b23be8092c53"


def run(args, **kw):
    p = sp.run(
        args, stdout=sp.PIPE, stderr=sp.STDOUT, timeout=kw.pop("timeout", 90), **kw
    )
    text = p.stdout.decode(errors="replace").replace(PASS, "<fixture>")
    if p.returncode:
        raise RuntimeError(f"{Path(args[0]).name} exit {p.returncode}: {text[-4000:]}")
    return text


REAL = {}


def sql(query, user="postgres"):
    return run(
        [
            "docker",
            "exec",
            "-i",
            REAL["pg"],
            "psql",
            "-XAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            user,
            "-d",
            "fixture",
        ],
        input=query.encode(),
    ).strip()


@contextlib.contextmanager
def real_services():
    if "--real" not in sys.argv:
        yield
        return
    sys.argv.remove("--real")
    api = ROOT.parent / "api"
    run(["bun", "install", "--frozen-lockfile"], cwd=api)
    with contextlib.ExitStack() as stack:

        def container(args):
            cid = run(["docker", "run", "-d", "--rm", *args]).strip().splitlines()[-1]
            stack.callback(run, ["docker", "rm", "-f", cid])
            return cid

        def port(cid, n):
            return int(run(["docker", "port", cid, str(n)]).strip().split(":")[-1])

        pg = container(
            [
                "-e",
                "POSTGRES_HOST_AUTH_METHOD=trust",
                "-e",
                "POSTGRES_DB=fixture",
                "-p",
                "127.0.0.1::5432",
                "pgvector/pgvector:pg17",
                "-c",
                "shared_preload_libraries=pg_stat_statements",
            ]
        )
        REAL["pg"] = pg
        pw = secrets.token_hex(24)
        s3 = container(
            [
                "-e",
                "MINIO_ROOT_USER=fixture",
                "-e",
                "MINIO_ROOT_PASSWORD=" + pw,
                "-p",
                "127.0.0.1::9000",
                "--entrypoint",
                "sh",
                "minio/minio:latest",
                "-c",
                "mkdir -p /data/mailgw; exec minio server /data",
            ]
        )
        db = f"postgres://postgres@127.0.0.1:{port(pg, 5432)}/fixture"
        until = time.monotonic() + 30
        while sp.run(
            ["docker", "exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
            capture_output=True,
        ).returncode:
            assert time.monotonic() < until
            time.sleep(0.1)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            http = s.getsockname()[1]
        url = f"http://127.0.0.1:{http}"
        secret = secrets.token_hex(32)
        key = secrets.token_hex(32)
        env = dict(
            PATH=os.environ["PATH"],
            HOME=os.environ["HOME"],
            HOST="127.0.0.1",
            PORT=str(http),
            PUBLIC_URL=url,
            BETTER_AUTH_SECRET=secret,
            DATABASE_URL=db,
            ENABLE_LIVE_SES="false",
            S3_BUCKET="mailgw",
            S3_ENDPOINT=f"http://127.0.0.1:{port(s3, 9000)}",
            S3_ACCESS_KEY_ID="fixture",
            S3_SECRET_ACCESS_KEY=pw,
            MAILGW_API_TOKEN=key,
            API_BASE_URL=url,
            AUTH_ALLOWED_EMAILS='operator@example.com',
            AUTH_ALLOWED_DOMAINS='example.com',
            GOOGLE_CLIENT_ID='fixture',
            GOOGLE_CLIENT_SECRET='fixture',
        )
        run(["node", "--import", "tsx", "src/migrate.ts"], cwd=api, env=env)
        prk = hmac.digest(bytes(32), secret.encode(), "sha256")
        pepper = hmac.digest(prk, b"bane:protocol-password:v1\x01", "sha256")
        digest = hmac.new(pepper, PASS.encode(), "sha256").hexdigest()
        sql(f"""CREATE EXTENSION pg_stat_statements; CREATE ROLE fixture_observer SUPERUSER LOGIN; CREATE ROLE fixture_listener LOGIN; GRANT CONNECT ON DATABASE fixture TO fixture_listener;
        INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES('fixture','default','fixture','example.invalid','us-east-1','active','store');
        INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES('default','us-east-1','mailgw','fixture');
        INSERT INTO mailboxes(id,workspace_id,domain_id,address,kind,retention_mode) VALUES('mbx_fixture','default','fixture','{USER}','inbox','forever');
        INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES('default','{USER}','mbx_fixture','primary'),('default','{ALIAS}','mbx_fixture','alias');
        INSERT INTO inbox_state(inbox_id,workspace_id) VALUES('mbx_fixture','default');
        INSERT INTO inbox_app_passwords VALUES('app_fixture','mbx_fixture','fixture','{digest}',ARRAY['smtp','imap']); UPDATE inbox_state SET protocol_passwords=1;
        """)
        log = stack.enter_context(open(ROOT / "target/real-api.log", "w"))
        for i in range(2):
            bid=f'mbx_load{i}';addr=f'load{i}@example.invalid';hashed=hmac.new(pepper,(PASS+str(i)).encode(),'sha256').hexdigest()
            sql(f"""INSERT INTO mailboxes(id,workspace_id,domain_id,address,kind,retention_mode) VALUES('{bid}','default','fixture','{addr}','inbox','forever');
            INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES('default','{addr}','{bid}','primary');
            INSERT INTO inbox_state(inbox_id,workspace_id) VALUES('{bid}','default');
            INSERT INTO inbox_app_passwords VALUES('app_load{i}','{bid}','fixture','{hashed}',ARRAY['imap']);UPDATE inbox_state SET protocol_passwords=1 WHERE inbox_id='{bid}';""")
        proc = sp.Popen(
            ["node", "--import", "tsx", "src/server.ts"],
            cwd=api,
            env=env,
            stdout=log,
            stderr=log,
        )
        stack.callback(lambda: (proc.terminate(), proc.wait(timeout=10)))
        run(
            [
                "curl",
                "--retry",
                "20",
                "--retry-all-errors",
                "--retry-delay",
                "1",
                "--fail",
                url + "/health",
            ]
        )
        REAL.update(
            MAILGW_API_TOKEN=key,
            MAILGW_API_URL=url,
            DATABASE_URL=db.replace("postgres@", "fixture_listener@"),
            MAILGW_HEALTH_PORT="0",
        )
        yield lambda:run(['node','--import','tsx','--test','--test-name-pattern=^mail gateway:|agent inbox contracts and storage budgets', 'api.acceptance.test.ts'],cwd=api,env=env)
        REAL.clear()


@contextlib.contextmanager
def gateway(tmp, **overrides):
    env = dict(
        os.environ,
        MAILGW_CERT=str(tmp / "cert.pem"),
        MAILGW_KEY=str(tmp / "key.pem"),
        MAILGW_FIXTURE_PASSWORD=PASS,
        MAILGW_IMAP_ENABLED="true",
        MAILGW_AUTH_SECONDS="5",
        **{"MAILGW_" + p + "_PORT": "0" for p in ("IMAP", "IMAPS", "SMTP", "SMTPS")},
    )
    env.update(overrides)
    if REAL:
        env.pop("MAILGW_FIXTURE_PASSWORD")
        env.update({k: v for k, v in REAL.items() if k != "pg"})
        if "MAILGW_MONTHLY" in overrides:
            sql(
                "UPDATE inbox_state SET protocol_monthly=(SELECT count(*)+1 FROM mail_messages WHERE sender_mailbox_id='mbx_fixture') WHERE inbox_id='mbx_fixture'"
            )
    with sp.Popen(
        [ROOT / "target/debug/mailgw"], env=env, stdout=sp.PIPE, text=True
    ) as proc:
        try:
            ports = {}
            for line in proc.stdout:
                if line.strip() == "READY":
                    break
                name, n = line.split()
                ports[name] = int(n)
            assert len(ports) == 4, "listener startup failed"
            yield ports, proc.pid
        finally:
            proc.terminate()
            if REAL and "MAILGW_MONTHLY" in overrides:
                sql("UPDATE inbox_state SET protocol_monthly=2000")


def connect(port,user=USER,password=PASS):
    c = imaplib.IMAP4_SSL("localhost", port, ssl_context=CTX, timeout=8)
    c.login(user,password)
    return c


def ok(result):
    assert result[0] == "OK", result
    return result[1]


def tls(p):
    with imaplib.IMAP4("localhost", p["IMAP"], timeout=6) as c:
        caps = ok(c.capability())[0].upper().split()
        assert b"LOGINDISABLED" in caps and b"AUTH=PLAIN" not in caps
        try:
            c.login(USER, PASS)
        except imaplib.IMAP4.error:
            pass
        else:
            raise AssertionError("plaintext login accepted")
        ok(c.starttls(CTX))
        ok(c.authenticate("PLAIN", lambda _: ("\0" + ALIAS + "\0" + PASS).encode()))
    with smtplib.SMTP("localhost", p["SMTP"], timeout=6) as c:
        c.ehlo()
        assert not c.has_extn("auth") and c.has_extn("starttls")
        assert c.docmd("AUTH", "PLAIN")[0] == 530
        c.starttls(context=CTX)
        assert c.docmd("AUTH", "LOGIN")[0] == 503
        c.ehlo()
        assert (
            c.auth(
                "LOGIN",
                lambda challenge=None: (
                    USER if not challenge or challenge.startswith(b"User") else PASS
                ),
            )[0]
            == 235
        )


def mail(p):
    with smtplib.SMTP_SSL("localhost", p["SMTPS"], context=CTX, timeout=6) as c:
        c.ehlo()
        c.login(ALIAS, PASS)
        assert c.mail("other@example.invalid")[0] == 553
        c.send(
            f"MAIL FROM:<{ALIAS}> SIZE={len(RAW)} BODY=8BITMIME\r\nRCPT TO:<sink@example.invalid>\r\nDATA\r\n".encode()
        )
        assert [c.getreply()[0] for _ in range(3)] == [250, 250, 354]
        c.send(RAW.replace(b"\r\n.", b"\r\n..") + b".\r\n")
        assert c.getreply()[0] == 250
        for field in [
            b"From: intruder@example.invalid\r\n",
            b"Sender: intruder@example.invalid\r\n"
            + RAW.split(b"\r\n", 1)[0]
            + b"\r\n",
        ]:
            c.mail(ALIAS)
            c.rcpt(USER)
            assert c.data(field + b"\r\nbody\r\n")[0] == 553
    with connect(p["IMAPS"]) as c:
        ok(c._simple_command("LIST", '""', '"*"', "RETURN", "(SPECIAL-USE)"))
        listed = b" ".join(c.response("LIST")[1])
        assert all(
            ("\\" + role).encode() in listed
            for role in ("Sent", "Drafts", "Trash", "Junk", "Archive")
        )
        ok(c.select("Sent"))
        assert ok(c.uid("FETCH", "*", "BODY.PEEK[]"))[0][1] == RAW
        before = ok(c.uid("SEARCH", None, "ALL"))
        ok(c.append("Sent", None, None, RAW))
        assert ok(c.uid("SEARCH", None, "ALL")) == before, (
            "client APPEND duplicated the submitted Sent copy"
        )
    # Exactly-sized RFC messages, including the terminating message CRLF but not DATA's dot.
    with smtplib.SMTP_SSL('localhost',p['SMTPS'],context=CTX,timeout=20) as c:
        c.ehlo();limit=int(c.esmtp_features['size']);assert limit==8<<20
        c.login(ALIAS,PASS)
        prefix=(f'From: {ALIAS}\r\nTo: reader@example.invalid\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n'
                '--fixture\r\nContent-Type: application/octet-stream; name="fixture.bin"\r\nContent-Disposition: attachment; filename="fixture.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n').encode()
        for size in (limit-1,limit,limit+1):
            status=c.mail(ALIAS,[f'SIZE={size}'])[0];assert status==(552 if size>limit else 250)
            if size>limit:continue
            suffix=b'\r\n--fixture--\r\n';row=b'YQBh'*19+b'\r\n';count,extra=divmod(size-len(prefix)-len(suffix),len(row))
            # Pad the epilogue, not the base64 payload.
            raw=prefix+row*count+suffix[:-2]+b' '*extra+b'\r\n';assert len(raw)==size
            c.rcpt('reader@example.invalid');reply=c.data(raw);assert reply[0]==250,reply


def client_flow(port):
    """Same script and exact octet assertions on both servers. Ignore only server-assigned identifiers, tags and response prose."""
    result = []
    with connect(port) as c:
        ok(c.create("Client"))
        ok(c.create("ClientDst"))
        ok(c.subscribe("Client"))
        assert any(b"Client" in x for x in ok(c.lsub('""', "Client")))
        ok(c.namespace())
        ok(c.xatom("ID", "NIL"))
        ok(c.append("Client", None, None, RAW))
        result.append(ok(c.select("Client")))
        uid = ok(c.uid("SEARCH", None, "ALL"))[0]
        assert len(uid.split()) == 1
        data = ok(
            c.uid(
                "FETCH",
                uid,
                "(FLAGS ENVELOPE BODYSTRUCTURE INTERNALDATE RFC822.SIZE BODY.PEEK[TEXT]<1.3>)",
            )
        )
        result.append(
            next(
                v[1] for v in data if isinstance(v, tuple) and b"BODY[TEXT]<1>" in v[0]
            )
        )
        assert result[-1] == b"dot"
        result.append(ok(c.uid("SEARCH", None, "UNSEEN"))[0] == uid)
        ok(c.uid("STORE", uid, "+FLAGS.SILENT", "(\\Flagged)"))
        result.append(ok(c.uid("SEARCH", None, "FLAGGED"))[0] == uid)
        ok(c.uid("COPY", uid, "ClientDst"))
        ok(c.uid("STORE", uid, "+FLAGS.SILENT", "(\\Deleted)"))
        ok(c.uid("EXPUNGE", uid))
        result.append(ok(c.uid("SEARCH", None, "ALL")))
        ok(c.select("ClientDst"))
        result.append(ok(c.uid("FETCH", "*", "BODY.PEEK[]"))[0][1])
        ok(c.uid("MOVE", "*", "Client"))
        result.append(ok(c.uid("SEARCH", None, "ALL")))
        ok(c.close())
        ok(c.delete("ClientDst"))
        ok(c.delete("Client"))
    assert result == [[b"1"], b"dot", True, True, [b""], RAW, [b""]], result
    return result


def changes(p):
    with connect(p["IMAPS"]) as r, connect(p["IMAPS"]) as w:
        ok(w.create("Changes"))
        ok(r.select("Changes"))
        r.send(b"i IDLE\r\n")
        assert r.readline().startswith(b"+")
        ok(w.append("Changes", None, None, RAW))
        assert r.readline() == b"* 1 EXISTS\r\n"
        ok(w.select("Changes"))
        ok(w.store("1", "+FLAGS", "(\\Deleted)"))
        assert b"\\Deleted" in r.readline()
        ok(w.expunge())
        assert r.readline() == b"* 1 EXPUNGE\r\n"
        r.send(b"DONE\r\n")
        assert r.readline().startswith(b"i OK")
        ok(w.close())
        ok(w.delete("Changes"))
        ok(w.create("Changes"))
        r.send(b"v NOOP\r\n")
        assert r.readline().startswith(b"* BYE")
        r.state = "LOGOUT"


def framing(p):
    with connect(p["IMAPS"]) as c:
        raw = b'Content-Type: multipart/mixed; boundary="absent"\r\nSubject: x\xff\r\n\r\nincomplete MIME\r\n'
        ok(c.create("Mime"))
        c.send(f"a APPEND Mime {{{len(raw)}+}}\r\n".encode() + raw + b"\r\n")
        assert c.readline().startswith(b"a OK [APPENDUID")
        ok(c.select("Mime", readonly=True))
        assert ok(c.fetch("1", "BODY[]"))[0][1] == raw
        assert ok(c.search(None, "UNSEEN")) == [b"1"]
        assert b"BODYSTRUCTURE" in ok(c.fetch("1", "BODYSTRUCTURE"))[0]
    with connect(p["IMAPS"]) as c:
        c.send(b"b APPEND INBOX {41943041}\r\n")
        assert c.readline() == b""
        c.state = "LOGOUT"


def deadline(p):
    for proto,greeting in [('IMAP',b'* OK'),('SMTP',b'220')]:
        with socket.create_connection(('localhost',p[proto]),timeout=5) as s:
            assert s.recv(2048).startswith(greeting)
            if proto=='IMAP': s.sendall(b'a CAP')
            assert not s.recv(1), 'idle or unfinished pre-auth command survived deadline'


def admission(tmp):
    with gateway(tmp, MAILGW_LOGIN_LIMIT="1", MAILGW_MONTHLY="1") as (p, _):
        with (
            connect(p["IMAPS"]),
            smtplib.SMTP_SSL("localhost", p["SMTPS"], context=CTX, timeout=5) as c,
        ):
            c.ehlo()
            token = base64.b64encode(f"\0{ALIAS}\0{PASS}".encode()).decode()
            assert c.docmd("AUTH", "PLAIN " + token)[0] == 421, (
                "alias bypassed the shared session limit"
            )
        for accepted, login in [(True, ALIAS), (False, USER)]:
            with smtplib.SMTP_SSL("localhost", p["SMTPS"], context=CTX, timeout=5) as c:
                c.login(login, PASS)
                if accepted:
                    c.mail(ALIAS);c.rcpt('first@example.invalid');c.rcpt('second@example.invalid')
                    assert c.data(RAW)[0]==451, 'recipient budget must reject the whole submission'
                c.mail(ALIAS)
                c.rcpt("other@example.invalid")
                assert c.data(RAW)[0] == (250 if accepted else 451)


def reference(tmp):
    conf = tmp / "dovecot.conf"
    conf.write_text(f"""protocols = imap
listen = *
default_vsz_limit = 0
service imap-login {{
 vsz_limit = 0
}}
service auth {{
 vsz_limit = 0
}}
ssl = required
ssl_cert = </fixture/cert.pem
ssl_key = </fixture/key.pem
mail_location = maildir:/tmp/fixture-mail
mail_uid = 1000
mail_gid = 1000
first_valid_uid = 1
log_path = /dev/stderr
passdb {{
 driver = static
 args = password={PASS}
}}
userdb {{
 driver = static
 args = uid=1000 gid=1000 home=/tmp
}}
""")
    cid = (
        run(
            [
                "docker",
                "create",
                "-p",
                "127.0.0.1::993",
                "-v",
                f"{tmp}:/fixture:ro",
                DOVECOT,
                "/usr/sbin/dovecot",
                "-F",
                "-c",
                "/fixture/dovecot.conf",
            ]
        )
        .strip()
        .splitlines()[-1]
    )
    try:
        run(["docker", "start", cid])
        port = int(
            run(
                [
                    "docker",
                    "inspect",
                    "--format",
                    '{{(index (index .NetworkSettings.Ports "993/tcp") 0).HostPort}}',
                    cid,
                ]
            ).strip()
        )
        end = time.monotonic() + 12
        while True:
            try:
                with connect(port):
                    break
            except (OSError, imaplib.IMAP4.abort):
                if time.monotonic() > end:
                    raise RuntimeError(run(["docker", "logs", cid])[-1000:])
                time.sleep(0.1)
        return client_flow(port)
    except Exception:
        print(run(["docker", "logs", cid])[-2000:])
        raise
    finally:
        run(["docker", "rm", "-f", cid])


def imaptest(tmp, p, stress=False):
    repo = ROOT / "target" / ("imaptest-" + SCRIPTS)
    if not repo.exists():
        run(["git", "init", "-q", repo])
        run(
            [
                "git",
                "-C",
                repo,
                "fetch",
                "-q",
                "--depth=1",
                "https://github.com/dovecot/imaptest.git",
                SCRIPTS,
            ]
        )
        run(["git", "-C", repo, "checkout", "-q", "FETCH_HEAD"])
    assert run(["git", "-C", repo, "rev-parse", "HEAD"]).strip() == SCRIPTS
    # All scripts are offered to the runner. Unsupported capabilities are its own SKIPs.
    args = [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{repo}/src/tests:/scripts:ro",
        IMAPTEST,
        "host=host.docker.internal",
        f"port={p['IMAPS']}",
        "ssl=any-cert",
        f"user={USER}",
        f"pass={PASS}",
        "mbox=/scripts/default.mbox",
    ]
    args += (
        [
            "clients=3",
            "secs=3,5",
            "seed=17",
            "-",
            "noop=30",
            "append=20",
            "fetch=30",
            "logout=0", # stress established sessions; handshake admission is tested separately
        ]
        if stress
        else ["test=/scripts", "clients=3"]
    )
    proc = sp.run(args, stdout=sp.PIPE, stderr=sp.STDOUT, timeout=180)
    output = proc.stdout.decode(errors="replace").replace(PASS, "<fixture>")
    log = (
        ROOT / "target" / ("imaptest-stress.log" if stress else "imaptest-scripts.log")
    )
    log.write_text(output)
    print(output[-400:], flush=True)
    if stress:
        assert (
            proc.returncode == 0 and "Totals:" in output and "Error:" not in output
        ), f"Stress failed: {log}"
        return
    scripts = repo / "src/tests"
    with connect(p["IMAPS"]) as c:
        caps = set(ok(c.capability())[0].upper().decode().split())
    skipped = []
    for script in sorted(scripts.iterdir()):
        if not script.is_file() or script.suffix:
            continue
        header = script.read_bytes().split(b"\n\n", 1)[0]
        match = re.search(rb"(?im)^capabilities: ([^\n]+)", header)
        missing = set(match[1].upper().decode().split()) - caps if match else set()
        if missing:
            skipped.append(script.name)
            print(f"SKIP {script.name}: requires {', '.join(sorted(missing))}")
    assert f"{len(skipped)} skipped due to missing capabilities" in output, (
        "skip ledger disagrees with upstream"
    )
    if proc.returncode == 0:
        assert re.search(r"\b0 failed,", output) and "Error:" not in output
        return
    # Run all upstream commands unmodified first. No catch-all XFAIL for a group:
    # any deviation other than the specific ten Recent-dependent commands fails the gate.
    failures = set(re.findall(r"^\*\*\* Test ([\w-]+) command (\d+)/", output, re.M))
    recent_failures = {
        (group, str(n))
        for group, ns in [
            ("copy", (16, 17, 20, 21)),
            ("search-flags", (18, 19, 20)),
            ("select", (3, 5, 6)),
        ]
        for n in ns
    }
    assert (
        not os.environ.get("MAILGW_STRICT_IMAPTEST")
        and proc.returncode == 2
        and failures == recent_failures
        and "Error:" not in output
    ), f"Upstream compliance failed: {log}"
    print(
        "UPSTREAM 3 groups differ on \\Recent; rerunning their full scripts with only recent expectations normalized."
    )
    profile = tmp / "recent-profile"
    profile.mkdir()
    shutil.copy(scripts / "default.mbox", profile)
    shutil.copy(scripts / "select.mbox", profile)
    for name in ("copy", "search-flags", "select"):
        data = (scripts / name).read_text()
        # rev1 compatibility in the Bane design: never set Recent, old == all, new == none.
        if name == "copy":
            data = (
                data.replace("* 3 recent\n", "")
                .replace("* 4 recent\n", "")
                .replace("\\recent ", "")
                .replace("\\recent)", ")")
            )
        if name == "select":
            data = data.replace("* 2 recent", "* 0 recent").replace(
                "messages 2 recent 2", "messages 2 recent 0"
            )
        if name == "search-flags":
            data = (
                data.replace("search new\n* search 1 3 4 5", "search new\n* search")
                .replace("search old\n* search\n", "search old\n* search 1 2 3 4 5\n")
                .replace("search recent\n* search 1 2 3 4 5", "search recent\n* search")
            )
        (profile / name).write_text(data)
    scoped = run(
        [a.replace(f"{scripts}:/scripts", f"{profile}:/scripts") for a in args]
    )
    print("BANE RECENT PROFILE", scoped[-200:])
    assert "3 test groups: 0 failed" in scoped and "Error:" not in scoped


def clients(tmp, p):
    run(
        [ROOT / "target/debug/examples/client"],
        env=dict(
            os.environ,
            MAILGW_FIXTURE_PASSWORD=PASS,
            MAILGW_CERT=str(tmp / "cert.pem"),
            MAILGW_IMAPS_PORT=str(p["IMAPS"]),
        ),
    )
    run(
        [
            "swaks",
            "--server",
            "localhost",
            "--port",
            str(p["SMTP"]),
            "--tls",
            "--auth",
            "PLAIN",
            "--auth-user",
            USER,
            "--auth-password",
            PASS,
            "--from",
            ALIAS,
            "--to",
            "sink@example.invalid",
            "--header",
            "Subject: swaks fixture",
        ]
    )
    rc = tmp / "neomuttrc"
    rc.write_text(f'''set smtp_url="smtps://primary%40example.invalid@localhost:{p["SMTPS"]}/"
set smtp_pass="{PASS}" smtp_authenticators=plain from="{USER}" use_from=yes copy=no
set certificate_file="{tmp / "cert.pem"}"
''')
    run(
        [
            "neomutt",
            "-n",
            "-F",
            str(rc),
            "-s",
            "NeoMutt fixture",
            "--",
            "sink@example.invalid",
        ],
        input=b"synthetic\n",
        env=dict(os.environ, HOME=str(tmp), SSL_CERT_FILE=str(tmp / "cert.pem")),
    )
    with connect(p["IMAPS"]) as c:
        ok(c.select("Sent"))
        for subject in ["swaks", "NeoMutt"]:
            assert ok(c.search(None, "SUBJECT", subject))[0]


def memory(tmp):
    with (
        gateway(tmp, MAILGW_LOGIN_LIMIT="300") as (p, pid),
        contextlib.ExitStack() as stack,
    ):
        rss = lambda: int(run(["ps", "-o", "rss=", "-p", str(pid)]).strip())
        base = 0
        for i in range(272):
            time.sleep(.11) # stay inside the production per-IP accept budget
            c = connect(p["IMAPS"])
            stack.callback(c.shutdown)
            ok(c.select("INBOX"))
            c.send(b"i IDLE\r\n")
            assert c.readline().startswith(b"+")
            if i == 15:
                base = rss()
        final = rss()
        print(
            f"IDLE measured {(final - base) / 256:.1f} KiB/connection (process RSS {base} -> {final} KiB, 16 -> 272 TLS IDLE sockets; excludes kernel)",
            flush=True,
        )


def large_folder(tmp):
    # Ordinary indexed mailbox workload in the disposable database only. Distinct
    # memberships and raw keys; no saved PoC traffic or external addresses.
    with gateway(tmp) as (p,pid), connect(p['IMAPS']) as c:
        ok(c.create('Capacity'));ok(c.append('Capacity',None,None,RAW))
        sql("""BEGIN;
        CREATE TEMP TABLE sample AS SELECT e.*,m.workspace_id,m.thread_id,m.size_bytes,m.raw_bucket FROM inbox_entries e JOIN inbox_folders f USING(inbox_id,role) JOIN mail_messages m ON m.id=e.message_id WHERE custom_path='Capacity';
        INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,size_bytes,raw_bucket,raw_key) SELECT 'bench-'||i,workspace_id,thread_id,'inbound','kept',size_bytes,raw_bucket,'k/default/bench-'||i||'.eml' FROM sample,generate_series(2,50001)i;
        INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,modseq) SELECT inbox_id,'bench-'||i,workspace_id,thread_id,'inbound',true,internal_date,modseq FROM sample,generate_series(2,50001)i;
        INSERT INTO inbox_entries SELECT inbox_id,role,i,'bench-'||i,modseq,false,internal_date FROM sample,generate_series(2,50001)i;
        INSERT INTO mailgw_previews SELECT m.id,m.raw_key,v.prefix,v.complete FROM sample JOIN mailgw_previews v ON v.mid=sample.message_id CROSS JOIN mail_messages m WHERE m.id LIKE 'bench-%';
        UPDATE inbox_folders SET total=50001,uid_next=50002 WHERE custom_path='Capacity';COMMIT;""",'fixture_observer')
        sql('ANALYZE inbox_entries; ANALYZE mailbox_messages; ANALYZE mail_messages; ANALYZE mailgw_previews','fixture_observer')
        c.sock.settimeout(25)
        rss=lambda:int(run(['ps','-p',str(pid),'-o','rss=']).strip())
        base=rss();start=time.perf_counter();assert ok(c.select('Capacity'))==[b'50001'];cold=time.perf_counter()-start;delta=rss()-base
        samples=[]
        for _ in range(20):
            start=time.perf_counter();assert ok(c.uid('SEARCH',None,'UNSEEN'))==[b'1'];ok(c.uid('FETCH','50001','(UID FLAGS RFC822.SIZE)'));samples.append((time.perf_counter()-start)*1000)
        p95=sorted(samples)[18];print(f'CAPACITY 50001 entries, SELECT {cold:.3f}s, selected RSS delta {delta/1024:.1f} MiB, p95 SEARCH+FETCH {p95:.1f}ms',flush=True)
        assert cold<5 and delta<96*1024 and p95<250, 'capacity budget exceeded'
        for name,op,count in [
            ('header sync',lambda:sum(isinstance(v,tuple) and b'From: alias@example.invalid' in v[1] for v in ok(c.uid('FETCH','1:*','(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])'))),50001),
            ('compound',lambda:len(ok(c.uid('SEARCH',None,'OR','FROM','alias','SUBJECT','none'))[0].split()),50001),
            ('filtered',lambda:len(ok(c.uid('SEARCH',None,'UNSEEN','SUBJECT','caf'))[0].split()),1),
            ('text',lambda:len(ok(c.uid('SEARCH',None,'TEXT','dot'))[0].split()),50001),
        ]:
            start=time.perf_counter();assert op()==count,name;elapsed=time.perf_counter()-start;print(f'50k {name}: {elapsed:.2f}s',flush=True);assert elapsed<12
        # Two other active inboxes select ordinary large folders and read metadata
        # concurrently. Assert both the measured footprint and the victim's latency.
        with contextlib.ExitStack() as clients,ThreadPoolExecutor(max_workers=2) as pool:
            neighbors=[]
            for i in range(2):
                bid=f'mbx_load{i}';n=clients.enter_context(connect(p['IMAPS'],f'load{i}@example.invalid',PASS+str(i)));neighbors.append(n)
                sql(f"""INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,modseq)
                SELECT '{bid}',m.id,'default',m.thread_id,'inbound',true,now(),1 FROM mail_messages m WHERE m.id LIKE 'bench-%';
                INSERT INTO inbox_entries SELECT '{bid}','inbox',i,'bench-'||i,1,false,now() FROM generate_series(2,50001)i;
                UPDATE inbox_folders SET total=50000,uid_next=50002 WHERE inbox_id='{bid}' AND role='inbox';""",'fixture_observer')
            def work(n):
                assert ok(n.select('INBOX'))==[b'50000'];
                for _ in range(12):ok(n.uid('FETCH','2:129','(UID FLAGS RFC822.SIZE)'))
            jobs=[pool.submit(work,n) for n in neighbors];latencies=[];peak=rss()
            while not all(job.done() for job in jobs):
                start=time.perf_counter();ok(c.uid('FETCH','1','(UID FLAGS RFC822.SIZE)'));latencies.append((time.perf_counter()-start)*1000);peak=max(peak,rss())
                time.sleep(.025)
            for job in jobs:job.result()
            p95=sorted(latencies)[int(.95*(len(latencies)-1))];print(f'THREE INBOXES: sampled peak {peak/1024:.1f} MiB; victim p95 {p95:.1f} ms',flush=True)
            assert peak<300*1024 and p95<250


def budgets(tmp):
    # Server statements only. Probe/fixture writes and pg_stat queries run as a different role.
    def count():
        return int(
            sql(
                "SELECT coalesce(sum(calls),0) FROM pg_stat_statements WHERE userid='postgres'::regrole AND dbid=(SELECT oid FROM pg_database WHERE datname=current_database())",
                "fixture_observer",
            )
        )

    def measure(name, expected, fn):
        n = count()
        result = fn()
        used = count() - n
        print(f"SQL {name}: {used}", flush=True)
        assert used == expected, (name, expected, used)
        return result

    with gateway(tmp) as (p, _), contextlib.ExitStack() as stack:

        def open_client():
            c = imaplib.IMAP4_SSL("localhost", p["IMAPS"], ssl_context=CTX, timeout=5)
            stack.callback(c.shutdown)
            return c

        a = open_client()
        measure("LOGIN cold", 1, lambda: ok(a.login(USER, PASS)))
        b = open_client()
        measure("LOGIN cached", 0, lambda: ok(b.login(USER, PASS)))
        ok(a.create("Budget"))
        ok(a.append("Budget", None, None, RAW))
        measure("SELECT", 1, lambda: ok(a.select("Budget")))
        ok(b.select("Budget"))
        measure("FETCH flags", 0, lambda: ok(a.fetch("1", "(UID FLAGS)")))
        assert measure("FETCH headers",0,lambda:ok(a.fetch('1','BODY.PEEK[HEADER]')))[0][1] == RAW.split(b'\r\n\r\n')[0]+b'\r\n\r\n'
        assert measure("SEARCH subject",1,lambda:ok(a.uid('SEARCH',None,'SUBJECT','caf'))) == [b'1']
        assert (
            measure("FETCH body PEEK", 0, lambda: ok(a.fetch("1", "BODY.PEEK[]")))[0][1]
            == RAW
        )
        for c in (a, b):
            c.send(b"i IDLE\r\n")
            assert c.readline().startswith(b"+")

        def wake():
            sql(
                "SELECT inbox_mutate('default','mbx_fixture',e.message_id,'flags','{\"read\":true}') FROM inbox_entries e JOIN inbox_folders f USING(inbox_id,role) WHERE f.custom_path='Budget' AND e.uid=1",
                "fixture_observer",
            )
            for c in (a, b):
                assert b"\\Seen" in c.readline()

        measure("IDLE wake, 2 sessions", 1, wake)
        sql("UPDATE inbox_state SET protocol_passwords=protocol_passwords+1 WHERE inbox_id='mbx_fixture'",'fixture_observer')
        for c in (a,b):
            c.send(b'DONE\r\n');assert c.readline().startswith(b'i OK')
        sql(
            "SELECT inbox_revoke_password('default','mbx_fixture','app_fixture')",
            "fixture_observer",
        )
        for c in (a, b):
            assert c.readline().startswith(b"* BYE"), "open session survived revocation"
        denied = open_client()
        try:
            denied.login(USER, PASS)
        except imaplib.IMAP4.error:
            pass
        else:
            raise AssertionError("revoked password survived warm login cache")


def shutdown(tmp):
    with gateway(tmp) as (p,pid):
        c=connect(p['IMAPS']);s=smtplib.SMTP_SSL('localhost',p['SMTPS'],context=CTX,timeout=5)
        try:
            s.ehlo();os.kill(pid,signal.SIGTERM)
            assert c.readline().startswith(b'* BYE') and s.getreply()[0]==421
        finally:
            c.shutdown();s.close()


def quotas(tmp):
    with gateway(tmp) as (p,_),connect(p['IMAPS']) as c:
        ok(c.create('Quota'));ok(c.select('Quota'))
        assert c.append('MissingFolder',None,None,RAW)[0]=='NO'
        ok(c.append('Quota',None,None,RAW))
        try:
            for column in ('quota_messages','quota_bytes'):
                sql(f"UPDATE mailboxes SET {column}=1 WHERE id='mbx_fixture'")
                if column=='quota_messages' and int(sql("SELECT messages FROM inbox_state WHERE inbox_id='mbx_fixture'"))==0:
                    ok(c.append('Quota',None,None,RAW))
                before=ok(c.search(None,'ALL'))
                assert c.append('Quota',None,None,RAW)[0]=='NO'
                assert ok(c.search(None,'ALL'))==before
                sql(f"UPDATE mailboxes SET {column}=NULL WHERE id='mbx_fixture'")
        finally:
            sql("UPDATE mailboxes SET quota_bytes=NULL,quota_messages=NULL WHERE id='mbx_fixture'")


def main():
    global CTX
    if not __debug__:
        raise RuntimeError("assertions must be enabled")
    os.chdir(ROOT)
    os.umask(0o077)
    run(["cargo", "build", "--locked", "--bins", "--examples"], timeout=300)
    success = []
    failed = []
    with real_services() as acceptance, tempfile.TemporaryDirectory(prefix="bane-e2e-") as d:
        tmp = Path(d).resolve()
        run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
                "-addext",
                "extendedKeyUsage=serverAuth",
                "-keyout",
                tmp / "key.pem",
                "-out",
                tmp / "cert.pem",
            ]
        )
        CTX = ssl.create_default_context(cafile=tmp / "cert.pem")
        with gateway(tmp) as (p, _):
            for name, fn in [
                ("TLS/STARTTLS", lambda: tls(p)),
                *([('API acceptance',acceptance)] if acceptance else []),
                ("submission", lambda: mail(p)),
                ("admission", lambda: admission(tmp)),
                ('shutdown',lambda:shutdown(tmp)),
                ("differential", lambda: client_flow(p["IMAPS"]) == reference(tmp)),
                ("IDLE/UIDVALIDITY", lambda: changes(p)),
                ("literals/MIME", lambda: framing(p)),
                ("preauth timeout", lambda: deadline(p)),
                ("Rust/swaks/NeoMutt", lambda: clients(tmp, p)),
                ("imaptest scripts", lambda: imaptest(tmp, p)),
                ("imaptest stress", lambda: imaptest(tmp, p, True)),
                ("IDLE RSS", lambda: memory(tmp)),
                *([('quotas',lambda:quotas(tmp)),("capacity",lambda:large_folder(tmp)),("DB budgets", lambda: budgets(tmp))] if REAL else []),
            ]:
                if len(sys.argv) > 1 and name not in sys.argv[1:]:
                    continue
                try:
                    assert fn() is not False
                    print("PASS", name, flush=True)
                    success.append(name)
                except Exception:
                    traceback.print_exc()
                    print("FAIL", name, flush=True)
                    failed.append(name)
    print(f"SUMMARY {len(success)} passed, {len(failed)} failed: {failed}", flush=True)
    return bool(failed or not success)


if __name__ == "__main__":
    sys.exit(main())
