// Synthetic email corpus for calibrating the email client emulator (src/email-preview) against real clients. Each
// fixture isolates one family of rendering behavior (layout, CSS support, fonts, images, buttons, dark mode, clipping)
// so a mismatch points at one rule. Everything is synthetic: example.com links, made-up names, and only Bane's own
// public assets (bane.mx) and Google Fonts as remote resources. No project imports, so scripts outside the API can
// load it with `node --import tsx` or bun.
//
//   import { emailPreviewCorpus } from './email-preview-corpus.js';

export interface EmailPreviewFixture {
  id: string;
  title: string;
  /** Behaviors the fixture exercises, for reading mismatches. */
  covers: string[];
  html: string;
}

const asset = (name: string) => `https://bane.mx/${name}`;
const heroImage = asset('og.png'); // 1200 × 630
const squareImage = asset('icon-512.png'); // 512 × 512
const logoImage = asset('apple-touch-icon.png'); // 180 × 180
const missingImage = asset('email-preview-missing.png'); // 404 on purpose

const doc = (title: string, body: string, head = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}
</head>
<body>
${body}
</body>
</html>`;

const label = (text: string) => `<p style="margin:16px 0 6px;font:600 11px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">${text}</p>`;

const basicTypography = doc('Basic typography', `
<h1>Welcome to Northwind</h1>
<p>Thanks for creating an account. This message uses no styles at all, so every font, size, margin and color comes from the client's defaults.</p>
<h2>What happens next</h2>
<p>Your workspace is ready. You can <a href="https://example.com/start">open the dashboard</a>, invite your team, or read the <a href="https://example.com/docs">getting started guide</a>.</p>
<ul>
  <li>Unlimited projects on every plan</li>
  <li>Daily backups, kept for <strong>30 days</strong></li>
  <li><em>Priority support</em> on weekdays</li>
</ul>
<h3>Three quick steps</h3>
<ol>
  <li>Verify your email address.</li>
  <li>Add a payment method.</li>
  <li>Invite at least one teammate.</li>
</ol>
<p style="font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:28px">A paragraph set in Georgia at 18/28 to show an explicit serif stack next to the default sans.</p>
<p style="font-size:12px;color:#888888">You received this because you signed up at example.com.</p>
`);

const tableLayout = doc('Table layout', `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef1f5">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;border:1px solid #d6dbe3">
    <tr><td bgcolor="#1f2a44" style="padding:20px 24px;color:#ffffff;font:bold 20px/26px Arial,sans-serif">Quarterly summary</td></tr>
    <tr><td style="padding:20px 24px;font:14px/21px Arial,sans-serif;color:#333333">A fixed 600 px table centered in a full-width background table, the classic email skeleton.</td></tr>
    <tr><td style="padding:0 24px 20px">
      <table role="presentation" width="100%" cellpadding="10" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#c9d1dc;font:13px/18px Arial,sans-serif">
        <tr bgcolor="#f3f5f8"><th align="left">Region</th><th align="right">Orders</th><th align="right">Revenue</th></tr>
        <tr><td>North</td><td align="right">1,204</td><td align="right">$48,160</td></tr>
        <tr><td>South</td><td align="right">986</td><td align="right">$39,440</td></tr>
        <tr bgcolor="#fafbfc"><td>West</td><td align="right">1,530</td><td align="right">$61,200</td></tr>
        <tr><td><strong>Total</strong></td><td align="right"><strong>3,720</strong></td><td align="right"><strong>$148,800</strong></td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="33%" valign="top" bgcolor="#fde68a" style="padding:14px;font:13px/18px Arial,sans-serif">Column one with a little more text so it wraps onto a second line.</td>
          <td width="2%"></td>
          <td width="30%" valign="middle" bgcolor="#bbf7d0" style="padding:14px;font:13px/18px Arial,sans-serif">Column two, middle aligned.</td>
          <td width="2%"></td>
          <td width="33%" valign="bottom" bgcolor="#bfdbfe" style="padding:14px;font:13px/18px Arial,sans-serif" align="right">Column three, bottom right.</td>
        </tr>
      </table>
    </td></tr>
  </table>
</td></tr>
</table>
`);

const box = (bg: string, text: string, extra = '') => `<div style="background:${bg};padding:16px;font:600 14px/20px Arial,sans-serif;color:#111827;${extra}">${text}</div>`;
const gridFlex = doc('Grid and flex', `
<div style="max-width:640px;margin:0 auto;padding:16px;font-family:Arial,sans-serif">
  ${label('display:flex, space-between, gap 12px')}
  <div style="display:flex;justify-content:space-between;gap:12px">
    ${box('#fecaca', 'Flex A', 'flex:1')}${box('#fde68a', 'Flex B', 'flex:2')}${box('#bbf7d0', 'Flex C', 'flex:1')}
  </div>
  ${label('display:flex, column, align center')}
  <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
    ${box('#e9d5ff', 'Centered one', 'width:200px')}${box('#c7d2fe', 'Centered two', 'width:300px')}
  </div>
  ${label('display:grid, three equal columns, gap 12px')}
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
    ${box('#fbcfe8', 'Grid 1')}${box('#a5f3fc', 'Grid 2')}${box('#d9f99d', 'Grid 3')}${box('#fed7aa', 'Grid 4')}${box('#ddd6fe', 'Grid 5')}${box('#99f6e4', 'Grid 6')}
  </div>
  ${label('display:grid with a spanning cell')}
  <div style="display:grid;grid-template-columns:2fr 1fr;grid-template-rows:auto auto;gap:12px">
    ${box('#fca5a5', 'Spans two rows', 'grid-row:span 2;min-height:80px')}${box('#93c5fd', 'Right top')}${box('#86efac', 'Right bottom')}
  </div>
  ${label('inline-block fallback row')}
  <div style="font-size:0">
    <div style="display:inline-block;width:32%;margin-right:2%;vertical-align:top">${box('#f5d0fe', 'Inline 1')}</div><div style="display:inline-block;width:32%;margin-right:2%;vertical-align:top">${box('#bae6fd', 'Inline 2')}</div><div style="display:inline-block;width:32%;vertical-align:top">${box('#fef08a', 'Inline 3')}</div>
  </div>
</div>
`);

const responsive = doc('Responsive media queries', `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:20px 10px">
  <!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
  <div class="container" style="max-width:600px;margin:0 auto;background:#ffffff">
    <div class="hero" style="padding:28px 24px;background:#0f766e;color:#ffffff;font:bold 26px/32px Arial,sans-serif">Fluid hybrid layout</div>
    <p class="show-mobile" style="display:none;margin:0;padding:12px 24px;background:#fef3c7;font:14px/20px Arial,sans-serif">Only on narrow screens.</p>
    <p class="hide-mobile" style="margin:0;padding:12px 24px;background:#e0f2fe;font:14px/20px Arial,sans-serif">Only on wide screens (hidden by a max-width query).</p>
    <div class="columns" style="font-size:0;padding:12px">
      <div class="col" style="display:inline-block;width:100%;max-width:288px;vertical-align:top">
        <div style="margin:6px;padding:16px;background:#fce7f3;font:14px/20px Arial,sans-serif">Left column. Two columns side by side above 600 px, stacked below.</div>
      </div><div class="col" style="display:inline-block;width:100%;max-width:288px;vertical-align:top">
        <div style="margin:6px;padding:16px;background:#ede9fe;font:14px/20px Arial,sans-serif">Right column with the same max-width so both fit in 600 px.</div>
      </div>
    </div>
    <p class="wide-accent" style="margin:0;padding:16px 24px;font:14px/20px Arial,sans-serif;color:#334155">This line turns red and bold only when a min-width:601px query applies.</p>
  </div>
  <!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
`, `<style>
  .container { width: 100%; }
  @media screen and (max-width: 600px) {
    .hero { font-size: 20px !important; line-height: 26px !important; }
    .col { max-width: 100% !important; display: block !important; }
    .hide-mobile { display: none !important; }
    .show-mobile { display: block !important; }
  }
  @media screen and (min-width: 601px) {
    .wide-accent { color: #dc2626 !important; font-weight: bold !important; }
  }
</style>`);

const webFonts = doc('Web fonts', `
<div style="max-width:600px;margin:0 auto;padding:20px">
  ${label('Google Fonts link: Lobster, fallback Georgia')}
  <p style="font-family:'Lobster',Georgia,serif;font-size:34px;line-height:42px;margin:0;color:#7c2d12">Handwritten headline</p>
  ${label('@import: Pacifico, fallback Courier New')}
  <p class="imported" style="font-family:'Pacifico','Courier New',monospace;font-size:28px;line-height:38px;margin:0;color:#1e3a8a">Imported font family</p>
  ${label('@font-face: Inter from bane.mx, fallback Verdana')}
  <p class="face" style="font-family:'BaneInter',Verdana,sans-serif;font-size:22px;line-height:30px;margin:0;color:#14532d">Self-hosted variable font</p>
  ${label('System stacks')}
  <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;margin:4px 0">-apple-system, Segoe UI, Roboto</p>
  <p style="font-family:'Trebuchet MS',sans-serif;font-size:18px;margin:4px 0">Trebuchet MS</p>
  <p style="font-family:Verdana,sans-serif;font-size:18px;margin:4px 0">Verdana</p>
  <p style="font-family:'Courier New',Courier,monospace;font-size:18px;margin:4px 0">Courier New</p>
  <p style="font-family:Tahoma,sans-serif;font-size:18px;margin:4px 0">Tahoma</p>
  <p style="font-family:'Times New Roman',Times,serif;font-size:18px;margin:4px 0">Times New Roman</p>
</div>
`, `<link href="https://fonts.googleapis.com/css2?family=Lobster&display=swap" rel="stylesheet">
<style>@import url('https://fonts.googleapis.com/css2?family=Pacifico&display=swap');</style>
<style>
  @font-face { font-family: 'BaneInter'; src: url('${asset('fonts/inter-variable.woff2')}') format('woff2'); font-weight: 100 900; }
  .face { letter-spacing: -0.01em; }
</style>`);

const backgroundImages = doc('Background images', `
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;margin:0 auto">
  <tr><td>${label('background attribute + bgcolor on a cell')}</td></tr>
  <tr><td background="${heroImage}" bgcolor="#1e293b" width="600" height="200" valign="bottom" style="padding:20px;color:#ffffff;font:bold 22px/28px Arial,sans-serif">Attribute background</td></tr>
  <tr><td>${label('inline background-image with size and position')}</td></tr>
  <tr><td style="background-color:#312e81;background-image:url('${heroImage}');background-size:cover;background-position:center;background-repeat:no-repeat;height:180px;padding:20px;color:#ffffff;font:bold 22px/28px Arial,sans-serif" valign="top">Inline background-image, cover</td></tr>
  <tr><td>${label('background shorthand, repeating tile')}</td></tr>
  <tr><td style="background:#fef3c7 url('${logoImage}') repeat;background-size:60px 60px;height:120px;padding:16px;font:bold 18px/24px Arial,sans-serif;color:#111827" valign="middle">Tiled shorthand</td></tr>
  <tr><td>${label('class background-image from a style block')}</td></tr>
  <tr><td class="classbg" style="height:140px;padding:16px;color:#ffffff;font:bold 18px/24px Arial,sans-serif;background-color:#7f1d1d" valign="bottom">Class background, dark red fallback</td></tr>
  <tr><td>${label('linear-gradient background')}</td></tr>
  <tr><td style="background-color:#0369a1;background-image:linear-gradient(135deg,#0ea5e9 0%,#6d28d9 100%);height:90px;padding:16px;color:#ffffff;font:bold 18px/24px Arial,sans-serif">Gradient, solid blue fallback</td></tr>
</table>
`, `<style>
  .classbg { background-image: url('${squareImage}'); background-size: 140px 140px; background-position: right center; background-repeat: no-repeat; }
</style>`);

const buttons = doc('Buttons', `
<div style="max-width:600px;margin:0 auto;padding:16px;font-family:Arial,sans-serif">
  ${label('Bulletproof table button (bgcolor cell, padded link)')}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td align="center" bgcolor="#2563eb" style="border-radius:6px"><a href="https://example.com/confirm" style="display:inline-block;padding:12px 24px;font:bold 15px/20px Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:6px">Confirm email</a></td>
  </tr></table>
  ${label('Padding link button with border')}
  <a href="https://example.com/view" style="display:inline-block;padding:10px 20px;border:2px solid #111827;border-radius:4px;font:bold 14px/18px Arial,sans-serif;color:#111827;text-decoration:none">View order</a>
  ${label('Border-based button')}
  <a href="https://example.com/reset" style="display:inline-block;background:#16a34a;border-top:12px solid #16a34a;border-bottom:12px solid #16a34a;border-left:28px solid #16a34a;border-right:28px solid #16a34a;font:bold 14px/16px Arial,sans-serif;color:#ffffff;text-decoration:none">Reset password</a>
  ${label('VML roundrect for Outlook, link for everyone else')}
  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://example.com/vml" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="20%" fillcolor="#db2777" stroke="f"><center style="color:#ffffff;font:bold 14px Arial,sans-serif;">VML button</center></v:roundrect><![endif]-->
  <!--[if !mso]><!--><a href="https://example.com/vml" style="display:inline-block;width:200px;height:44px;line-height:44px;text-align:center;background:#db2777;border-radius:9px;font:bold 14px Arial,sans-serif;color:#ffffff;text-decoration:none">VML button</a><!--<![endif]-->
  ${label('Pill with shadow, full-width block, and a button element')}
  <a href="https://example.com/pill" style="display:inline-block;padding:10px 26px;border-radius:999px;background:#f59e0b;box-shadow:0 4px 10px rgba(0,0,0,.25);font:bold 14px/18px Arial,sans-serif;color:#1f2937;text-decoration:none">Pill button</a>
  <a href="https://example.com/block" style="display:block;margin-top:14px;padding:14px 0;text-align:center;background:#0f172a;font:bold 15px/20px Arial,sans-serif;color:#f8fafc;text-decoration:none">Full-width block link</a>
  <p style="margin:14px 0 0"><button type="button" style="padding:10px 18px;background:#7c3aed;color:#ffffff;border:0;border-radius:6px;font:bold 14px Arial,sans-serif">Button element</button></p>
</div>
`);

const darkMode = doc('Dark mode support', `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background:#f4f4f5">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="card" style="width:560px;background:#ffffff;border-radius:10px">
    <tr><td style="padding:24px 28px 8px">
      <img class="logo-light" src="${logoImage}" width="48" height="48" alt="Logo" style="display:block;border-radius:10px">
      <div class="logo-dark" style="display:none;max-height:0;overflow:hidden;mso-hide:all"><img src="${squareImage}" width="48" height="48" alt="Logo (dark)" style="display:block;border-radius:10px"></div>
    </td></tr>
    <tr><td class="text" style="padding:8px 28px;font:16px/24px Arial,sans-serif;color:#18181b">
      <h1 class="heading" style="margin:0 0 8px;font:bold 24px/30px Arial,sans-serif;color:#09090b">Light by default, dark when asked</h1>
      This card declares color-scheme light dark and has prefers-color-scheme rules. A light theme should show it unchanged: white card, near-black text, gray page.
    </td></tr>
    <tr><td style="padding:12px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="33%" style="background:#000000;color:#ffffff;padding:12px;font:bold 13px Arial,sans-serif">Pure black</td>
        <td width="33%" style="background:#ffffff;color:#000000;padding:12px;font:bold 13px Arial,sans-serif;border:1px solid #e4e4e7">Pure white</td>
        <td width="33%" style="background:#2563eb;color:#ffffff;padding:12px;font:bold 13px Arial,sans-serif">Brand blue</td>
      </tr></table>
    </td></tr>
    <tr><td class="muted" style="padding:12px 28px 28px;font:13px/20px Arial,sans-serif;color:#71717a">Muted footer text in zinc-500.</td></tr>
  </table>
</td></tr>
</table>
`, `<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .page { background: #09090b !important; }
    .card { background: #18181b !important; }
    .text, .heading { color: #fafafa !important; }
    .muted { color: #a1a1aa !important; }
    .logo-light { display: none !important; }
    .logo-dark { display: block !important; max-height: none !important; }
  }
  [data-ogsc] .heading { color: #fafafa !important; }
</style>`);

const clipRow = (i: number) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font:13px/18px Arial,sans-serif;color:#374151">Activity ${String(i).padStart(4, '0')}: synthetic log line used to push the message past the client's size limit.</td><td align="right" style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font:13px/18px Arial,sans-serif;color:#6b7280">${(i * 37) % 1000} ms</td></tr>`;
// About 130 KB of HTML, past Gmail's 102 KB clipping threshold.
const clipping = doc('Long message', `
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;margin:0 auto">
  <tr><td colspan="2" style="padding:16px 10px;font:bold 20px/26px Arial,sans-serif;color:#111827">Weekly activity export</td></tr>
  <tr><td colspan="2" style="padding:0 10px 12px;font:14px/20px Arial,sans-serif;color:#4b5563">The table below is long enough that Gmail clips the message and shows a link to view it whole.</td></tr>
  ${Array.from({ length: 380 }, (_, i) => clipRow(i + 1)).join('\n  ')}
  <tr><td colspan="2" style="padding:16px 10px;font:bold 14px Arial,sans-serif;color:#b91c1c">End of export (past the clipping point).</td></tr>
</table>
`);

const imagesSizing = doc('Images and sizing', `
<div style="max-width:600px;margin:0 auto;padding:16px;font-family:Arial,sans-serif">
  ${label('Full-width hero: width=600, max-width 100%, height auto')}
  <img src="${heroImage}" width="600" alt="Hero" style="display:block;width:100%;max-width:600px;height:auto;border:0">
  ${label('Inline images (baseline gap) vs display:block')}
  <div style="background:#e5e7eb"><img src="${logoImage}" width="60" height="60" alt="Inline"> <img src="${logoImage}" width="60" height="60" alt="Inline"></div>
  <div style="background:#d1d5db;margin-top:8px"><img src="${logoImage}" width="60" height="60" alt="Block" style="display:block"></div>
  ${label('Height attribute only, rounded, and a 512 px image shown at 96 px')}
  <img src="${squareImage}" height="80" alt="Height only"> <img src="${squareImage}" width="80" height="80" alt="Rounded" style="border-radius:50%"> <img src="${squareImage}" width="96" alt="Downscaled" style="width:96px;height:96px">
  ${label('Missing image with styled alt text')}
  <img src="${missingImage}" width="300" height="80" alt="Alt text for a missing image" style="display:block;background:#fee2e2;color:#991b1b;font:bold 16px Arial,sans-serif;border:0">
  ${label('Linked image and image with a border attribute')}
  <a href="https://example.com/gallery"><img src="${logoImage}" width="72" height="72" alt="Linked"></a>
  <img src="${logoImage}" width="72" height="72" border="4" alt="Bordered" style="border:4px solid #f97316">
</div>
`);

const styleBlocks = doc('Style block selectors', `
<div class="wrap">
  <p class="t-class">Class selector: green background.</p>
  <p id="t-id">ID selector: purple background.</p>
  <table role="presentation"><tr><td><span class="t-child">Child combinator (td &gt; span): orange background.</span></td></tr></table>
  <p class="t-first">Adjacent sibling source.</p>
  <p class="t-next">Adjacent sibling (+): blue background.</p>
  <p data-kind="attr">Attribute selector [data-kind]: pink background.</p>
  <p class="t-var">CSS variable color: teal background, falls back to gray.</p>
  <p class="t-calc">calc() width: half width minus 20 px, yellow.</p>
  <p class="t-important" style="background:#ffffff">!important beats inline: lime background.</p>
  <p class="t-pseudo">::before pseudo-element prefix.</p>
  <p class="t-nth"><span>a</span><span>b</span><span>c</span> :nth-child(2) is red.</p>
  <p class="t-element">Element selector on strong: <strong>this strong is underlined and red</strong>.</p>
  <p class="t-uppercase" style="text-transform:none">Inline text-transform none wins over the class's uppercase.</p>
</div>
`, `<style>.wrap { max-width: 600px; margin: 0 auto; padding: 12px; font: 15px/22px Arial, sans-serif; } .wrap p { margin: 6px 0; padding: 8px 12px; background: #f3f4f6; }</style>
<style>.wrap .t-class { background: #bbf7d0; }</style>
<style>#t-id { background: #e9d5ff; }</style>
<style>td > .t-child { background: #fed7aa; display: block; padding: 8px 12px; }</style>
<style>.t-first + .t-next { background: #bfdbfe; }</style>
<style>[data-kind="attr"] { background: #fbcfe8 !important; }</style>
<style>.wrap .t-var { --accent: #99f6e4; background: var(--accent, #d1d5db); }</style>
<style>.wrap .t-calc { width: calc(50% - 20px); background: #fef08a; }</style>
<style>.wrap .t-important { background: #d9f99d !important; }</style>
<style>.t-pseudo::before { content: '★ '; color: #d97706; font-weight: bold; }</style>
<style>.t-nth span:nth-child(2) { color: #dc2626; font-weight: bold; }</style>
<style>.t-element strong { text-decoration: underline; color: #b91c1c; }</style>
<style>.wrap .t-uppercase { text-transform: uppercase; background: #e0e7ff; }</style>`);

const typography = doc('Typography details', `
<div style="max-width:600px;margin:0 auto;padding:16px;font:15px/22px Arial,sans-serif;color:#1f2937">
  <p style="font-size:32px;line-height:36px;font-weight:800;letter-spacing:-0.02em;margin:0 0 8px">Tight display heading</p>
  <p style="font-size:11px;line-height:14px;letter-spacing:.2em;text-transform:uppercase;color:#6b7280;margin:0 0 12px">Spaced uppercase eyebrow</p>
  <p style="margin:0 0 12px"><span style="font-weight:300">Light 300</span> · <span style="font-weight:400">Regular 400</span> · <span style="font-weight:600">Semibold 600</span> · <span style="font-weight:900">Black 900</span> · <i>Italic</i> · <span style="font-variant:small-caps">Small Caps</span></p>
  <p style="margin:0 0 12px"><s>Struck</s> · <u>underlined</u> · <span style="text-decoration:underline wavy #dc2626">wavy</span> · <mark>marked</mark> · H<sub>2</sub>O · x<sup>2</sup> · <small>small</small> · <kbd>⌘K</kbd> · <abbr title="Application Programming Interface">API</abbr></p>
  <p style="margin:0 0 12px;text-shadow:1px 1px 2px rgba(0,0,0,.4);font-size:20px">Text with a soft shadow</p>
  <blockquote style="margin:0 0 12px;padding:8px 14px;border-left:4px solid #9ca3af;color:#4b5563">A blockquote with a left border and muted color.</blockquote>
  <blockquote>An unstyled blockquote using the client's default margins.</blockquote>
  <pre style="margin:0 0 12px;padding:12px;background:#0f172a;color:#e2e8f0;font:13px/19px 'Courier New',monospace;white-space:pre;overflow:auto">curl https://api.example.com/v1/items \\
  -H "Authorization: Bearer $TOKEN"</pre>
  <p style="margin:0 0 12px">Inline <code>code()</code> and <code style="background:#f3f4f6;padding:2px 4px;border-radius:3px;font-family:Menlo,Consolas,monospace">styled_code</code>.</p>
  <hr>
  <hr style="border:0;border-top:2px dashed #f43f5e;margin:12px 0">
  <p style="margin:0 0 12px;word-break:break-all">https://example.com/a/very/long/unbroken/url/that/should/wrap/somewhere/instead/of/overflowing/the/content/area?with=query&amp;and=more</p>
  <p dir="rtl" style="margin:0 0 12px">نص من اليمين إلى اليسار مع أرقام 123</p>
  <p style="margin:0 0 12px">Emoji and symbols: ✅ 🚀 📦 → € £ ¥ — “quotes”</p>
  <p style="margin:0;line-height:1;background:#fef9c3">Line-height 1 on a background</p>
  <p style="margin:4px 0 0;line-height:40px;background:#e0f2fe">Line-height 40 px on a background</p>
</div>
`);

const positioning = doc('Positioning and overflow', `
<div style="max-width:600px;margin:0 auto;padding:16px;font:14px/20px Arial,sans-serif;color:#111827">
  ${label('position:relative card with an absolute badge')}
  <div style="position:relative;padding:20px;background:#f1f5f9;border:1px solid #cbd5e1">
    Card body text.
    <span style="position:absolute;top:8px;right:8px;padding:2px 8px;background:#dc2626;color:#ffffff;font-weight:bold;border-radius:10px">NEW</span>
  </div>
  ${label('Negative margin pulls the box up')}
  <div style="height:40px;background:#c7d2fe"></div>
  <div style="margin:-20px 20px 0;padding:10px;background:#fde68a">Overlapping by negative margin</div>
  ${label('overflow:hidden with border-radius clipping an image')}
  <div style="width:220px;height:110px;overflow:hidden;border-radius:16px;background:#e5e7eb"><img src="${heroImage}" width="320" alt="Clipped" style="display:block;width:320px"></div>
  ${label('Transforms and opacity')}
  <div style="display:inline-block;margin:10px 20px;padding:10px 16px;background:#fca5a5;transform:rotate(-6deg)">Rotated</div>
  <div style="display:inline-block;margin:10px 20px;padding:10px 16px;background:#86efac;opacity:.5">Half opacity</div>
  ${label('Floats with clear')}
  <div style="float:left;width:45%;padding:10px;background:#a5f3fc;box-sizing:border-box">Float left</div>
  <div style="float:right;width:45%;padding:10px;background:#f5d0fe;box-sizing:border-box">Float right</div>
  <div style="clear:both;padding-top:8px">Cleared below the floats.</div>
  ${label('Fixed height with overflow:auto, box-shadow, outline')}
  <div style="height:60px;overflow:auto;padding:8px;border:1px solid #9ca3af;box-shadow:0 6px 16px rgba(0,0,0,.2);outline:3px solid #f59e0b;outline-offset:3px">Line 1<br>Line 2<br>Line 3<br>Line 4<br>Line 5</div>
  ${label('position:fixed footer (should not stick to the viewport)')}
  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px;background:#111827;color:#f9fafb;text-align:center">Fixed bar</div>
  <p style="margin:12px 0 0">End of positioning tests.</p>
</div>
`);

const interactive = doc('Interactive and embedded content', `
<div style="max-width:600px;margin:0 auto;padding:16px;font:14px/20px Arial,sans-serif;color:#111827">
  ${label('Form controls')}
  <form action="https://example.com/survey" method="get" style="margin:0">
    <input type="text" name="name" placeholder="Your name" style="padding:8px;border:1px solid #9ca3af;width:200px">
    <select name="rating" style="padding:6px"><option>Great</option><option>Fine</option></select>
    <label><input type="checkbox" name="news" checked> Subscribe</label><br>
    <textarea name="comment" rows="2" style="width:300px;margin-top:8px">Prefilled comment</textarea><br>
    <input type="submit" value="Send feedback" style="margin-top:8px;padding:8px 14px;background:#0ea5e9;color:#ffffff;border:0">
  </form>
  ${label('details / summary')}
  <details><summary style="cursor:pointer;font-weight:bold">Show shipping details</summary><p style="margin:6px 0">Ships in 2 business days.</p></details>
  ${label('Inline SVG with an image fallback after it')}
  <svg width="120" height="60" viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="60" rx="8" fill="#22c55e"/><text x="60" y="36" font-size="16" text-anchor="middle" fill="#ffffff" font-family="Arial">SVG</text></svg>
  <img src="${asset('brand/bane-mark.svg')}" width="40" height="40" alt="SVG as img">
  ${label('Video with poster, then audio and iframe')}
  <video width="320" height="168" poster="${heroImage}" controls><source src="https://example.com/clip.mp4" type="video/mp4"><a href="https://example.com/clip"><img src="${heroImage}" width="320" alt="Play video"></a></video>
  <audio controls src="https://example.com/sound.mp3">Audio fallback text.</audio>
  <iframe src="https://example.com/embed" width="320" height="80" style="border:1px solid #9ca3af">Iframe fallback text.</iframe>
  ${label('Checkbox hack toggle')}
  <input type="checkbox" id="toggle" class="toggle" style="display:none">
  <label for="toggle" style="display:inline-block;padding:6px 12px;background:#e5e7eb;cursor:pointer">Toggle panel</label>
  <div class="panel" style="padding:10px;background:#fef3c7">Panel visible by default; hidden when toggled where supported.</div>
</div>
`, `<style>.toggle:checked ~ .panel { display: none !important; }</style>`);

const receiptRow = (item: string, qty: number, price: string) => `<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;font:14px/20px Arial,sans-serif;color:#1f2937">${item}<br><span style="font-size:12px;color:#6b7280">Qty ${qty}</span></td><td align="right" valign="top" style="padding:10px 0;border-bottom:1px solid #eceef1;font:14px/20px Arial,sans-serif;color:#1f2937">${price}</td></tr>`;
const receipt = doc('Your receipt', `
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f6f7f9">Order NW-20481 is confirmed. Hidden preheader text that should never be visible.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:32px 12px">
  <!--[if mso]><table role="presentation" width="560"><tr><td><![endif]-->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px">
    <tr><td style="padding:28px 32px 0"><img src="${logoImage}" width="40" height="40" alt="Northwind" style="display:block;border-radius:8px"></td></tr>
    <tr><td style="padding:20px 32px 4px;font:bold 22px/28px Arial,sans-serif;color:#111827">Thanks for your order, Sam</td></tr>
    <tr><td style="padding:0 32px 20px;font:14px/21px Arial,sans-serif;color:#4b5563">Order <strong>NW-20481</strong> · Placed 12 November 2026</td></tr>
    <tr><td style="padding:0 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${receiptRow('Ceramic pour-over set', 1, '$48.00')}
        ${receiptRow('Paper filters, 100 pack', 2, '$12.00')}
        ${receiptRow('Single-origin beans, 250 g', 3, '$54.00')}
        <tr><td style="padding:12px 0 4px;font:14px Arial,sans-serif;color:#6b7280">Subtotal</td><td align="right" style="padding:12px 0 4px;font:14px Arial,sans-serif;color:#6b7280">$114.00</td></tr>
        <tr><td style="padding:4px 0;font:14px Arial,sans-serif;color:#6b7280">Shipping</td><td align="right" style="padding:4px 0;font:14px Arial,sans-serif;color:#6b7280">Free</td></tr>
        <tr><td style="padding:8px 0 0;font:bold 16px Arial,sans-serif;color:#111827">Total</td><td align="right" style="padding:8px 0 0;font:bold 16px Arial,sans-serif;color:#111827">$114.00</td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#111827" style="border-radius:8px"><a href="https://example.com/orders/NW-20481" style="display:inline-block;padding:12px 28px;font:bold 15px/20px Arial,sans-serif;color:#ffffff;text-decoration:none">Track your order</a></td></tr></table>
    </td></tr>
    <tr><td style="padding:0 32px 28px;font:13px/20px Arial,sans-serif;color:#4b5563">Shipping to<br>Sam Rivera<br>100 Example Street<br>Springfield, ST 00000</td></tr>
  </table>
  <!--[if mso]></td></tr></table><![endif]-->
  <p style="margin:16px 0 0;font:12px/18px Arial,sans-serif;color:#9ca3af;text-align:center">Northwind Coffee · 100 Example Street · <a href="https://example.com/help" style="color:#6b7280">Help</a> · <a href="https://example.com/privacy" style="color:#6b7280">Privacy</a></p>
</td></tr>
</table>
`);

const card = (title: string, text: string, color: string) => `<td class="stack" width="50%" valign="top" style="padding:8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px"><tr><td style="height:6px;background:${color};border-radius:8px 8px 0 0;font-size:0;line-height:0">&nbsp;</td></tr><tr><td style="padding:14px 16px 4px;font:bold 16px/22px Georgia,serif;color:#111827">${title}</td></tr><tr><td style="padding:0 16px 16px;font:14px/21px Georgia,serif;color:#4b5563">${text}</td></tr></table></td>`;
const newsletter = doc('Newsletter', `
<center style="width:100%;background:#fafaf9">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;margin:0 auto;background:#ffffff">
    <tr><td style="padding:20px 24px;border-bottom:3px solid #111827"><span style="font:bold 13px Arial,sans-serif;letter-spacing:.15em;color:#111827">THE NORTHWIND DISPATCH</span><span style="float:right;font:12px Arial,sans-serif;color:#6b7280">Issue 42</span></td></tr>
    <tr><td><img src="${heroImage}" width="600" alt="This week's cover" style="display:block;width:600px;height:auto"></td></tr>
    <tr><td style="padding:24px 24px 8px;font:bold 28px/34px Georgia,serif;color:#111827">Small batches, shipped weekly</td></tr>
    <tr><td style="padding:0 24px 16px;font:16px/26px Georgia,serif;color:#374151">A centered newsletter: a <code>center</code> wrapper, a full-width hero, two-column cards, social links and a footer, all in table layout.</td></tr>
    <tr><td style="padding:0 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${card('Roaster notes', 'How we profile a new lot in three test roasts before it ships.', '#f97316')}
      ${card('Brew guide', 'A slower pour for lighter roasts, with timings for 300 ml.', '#0ea5e9')}
    </tr><tr>
      ${card('Community', 'Readers sent 214 photos of their morning setup this week.', '#22c55e')}
      ${card('Events', 'Cupping night on the 20th. Spots are limited to twelve.', '#a855f7')}
    </tr></table></td></tr>
    <tr><td align="center" style="padding:20px 24px"><a href="https://example.com/issue/42" style="display:inline-block;padding:12px 30px;background:#f97316;border-radius:4px;font:bold 15px Arial,sans-serif;color:#ffffff;text-decoration:none">Read the full issue</a></td></tr>
    <tr><td align="center" style="padding:8px 24px 16px">
      <a href="https://example.com/a"><img src="${logoImage}" width="28" height="28" alt="A" style="border-radius:50%;margin:0 6px"></a><a href="https://example.com/b"><img src="${logoImage}" width="28" height="28" alt="B" style="border-radius:50%;margin:0 6px"></a><a href="https://example.com/c"><img src="${logoImage}" width="28" height="28" alt="C" style="border-radius:50%;margin:0 6px"></a>
    </td></tr>
    <tr><td align="center" style="padding:16px 24px 28px;background:#f5f5f4;font:12px/18px Arial,sans-serif;color:#78716c">You are reading a synthetic newsletter.<br><a href="https://example.com/unsubscribe" style="color:#57534e">Unsubscribe</a> · <a href="https://example.com/preferences" style="color:#57534e">Preferences</a></td></tr>
  </table>
</center>
`, `<style>
  @media screen and (max-width: 600px) { .stack { display: block !important; width: 100% !important; } }
</style>`);

export const emailPreviewCorpus: EmailPreviewFixture[] = [
  { id: 'basic-typography', title: 'Basic typography', covers: ['client default font and size', 'heading and list defaults', 'link color'], html: basicTypography },
  { id: 'table-layout', title: 'Table layout', covers: ['600 px centered table', 'bgcolor, border and cellpadding attributes', 'valign and align'], html: tableLayout },
  { id: 'grid-flex', title: 'Grid and flex', covers: ['display:flex', 'display:grid', 'gap', 'inline-block fallback'], html: gridFlex },
  { id: 'responsive', title: 'Responsive media queries', covers: ['@media max-width and min-width', 'class selectors', 'fluid hybrid columns', 'mso conditionals'], html: responsive },
  { id: 'web-fonts', title: 'Web fonts', covers: ['<link> stylesheet', '@import', '@font-face', 'fallback stacks'], html: webFonts },
  { id: 'background-images', title: 'Background images', covers: ['background attribute', 'background-image and background-size', 'shorthand', 'class background', 'linear-gradient'], html: backgroundImages },
  { id: 'buttons', title: 'Buttons', covers: ['bulletproof table button', 'border-radius', 'border buttons', 'VML conditionals', 'box-shadow', '<button>'], html: buttons },
  { id: 'dark-mode', title: 'Dark mode support', covers: ['color-scheme meta', 'prefers-color-scheme', '[data-ogsc]', 'hidden dark logo'], html: darkMode },
  { id: 'clipping', title: 'Long message', covers: ['Gmail 102 KB clipping'], html: clipping },
  { id: 'images', title: 'Images and sizing', covers: ['max-width:100% images', 'inline image baseline gap', 'alt text on a missing image', 'border-radius on images'], html: imagesSizing },
  { id: 'style-blocks', title: 'Style block selectors', covers: ['class, id, child, sibling and attribute selectors', 'CSS variables', 'calc()', '!important vs inline', 'pseudo-elements'], html: styleBlocks },
  { id: 'typography', title: 'Typography details', covers: ['letter-spacing and text-transform', 'font weights', 'pre and code', 'blockquote and hr', 'RTL and emoji', 'line-height'], html: typography },
  { id: 'positioning', title: 'Positioning and overflow', covers: ['position', 'negative margins', 'overflow and border-radius clipping', 'transform and opacity', 'floats', 'position:fixed'], html: positioning },
  { id: 'interactive', title: 'Interactive and embedded content', covers: ['forms', 'details', 'inline SVG', 'video, audio and iframe', 'checkbox hack'], html: interactive },
  { id: 'receipt', title: 'Receipt', covers: ['hidden preheader', 'realistic transactional layout', 'max-width card with border-radius'], html: receipt },
  { id: 'newsletter', title: 'Newsletter', covers: ['center wrapper', 'hero image', 'two-column cards', 'float in a header', 'social icons'], html: newsletter },
];
