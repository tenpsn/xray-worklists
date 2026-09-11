#!/usr/bin/env node
/*
 * Move (copy) studies from a source Orthanc to a destination PACS via DICOM C-STORE.
 * Behaves exactly like the "Orthanc Study Mover" web page (copy-only, never deletes
 * the source), but runs as a standalone Node.js script — no Docker/web app needed.
 * Use this when the machine running the web app can't reach the source Orthanc's
 * network, but another machine (e.g. on the same LAN as the PACS) can run Node.js.
 *
 * Requires Node.js 18 or later (uses the built-in fetch, no npm install needed).
 *
 * Usage with all values given up front:
 *   node movestudy.js \
 *     --source http://192.168.250.110/orthanc \
 *     --from 2026-01-01 --to 2026-12-31 \
 *     --dest-aet REMOTEPACS --dest-host 10.0.0.5 --dest-port 104 \
 *     [--username user] [--password pass]
 *
 * Or just run it with no options and answer the prompts instead:
 *   node movestudy.js
 *
 * See all options: node movestudy.js --help
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      const trimmed = String(answer || '').trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

async function fillMissingArgsInteractively(args) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!args.source) args.source = await ask(rl, 'Source Orthanc URL');
    if (!args.from) args.from = await ask(rl, 'Start date (YYYY-MM-DD)');
    if (!args.to) args.to = await ask(rl, 'End date (YYYY-MM-DD)');
    if (!args['dest-aet']) args['dest-aet'] = await ask(rl, 'Destination AE Title');
    if (!args['dest-host']) args['dest-host'] = await ask(rl, 'Destination Host/IP');
    if (!args['dest-port']) args['dest-port'] = await ask(rl, 'Destination DICOM Port');
    if (!args['dest-rest-url']) {
      const defaultRestUrl = args['dest-host'] ? `http://${args['dest-host']}:${DEFAULT_DEST_REST_PORT}` : '';
      args['dest-rest-url'] = await ask(
        rl,
        'Destination REST API URL (used to verify transfers really finished)',
        defaultRestUrl
      );
    }
    if (!args.username) args.username = await ask(rl, 'Source Orthanc username (leave blank if none)');
    if (!args.password) args.password = await ask(rl, 'Source Orthanc password (leave blank if none)');
    if (!args['modality-name']) {
      args['modality-name'] = await ask(rl, 'Temporary modality name on the source', 'MOVER-CLI');
    }
  } finally {
    rl.close();
  }
  return args;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Move (copy) studies from a source Orthanc to a destination PACS via DICOM C-STORE.

Required options:
  --source       Source Orthanc URL (e.g. http://192.168.250.110/orthanc)
  --from         Start date (YYYY-MM-DD)
  --to           End date (YYYY-MM-DD)
  --dest-aet     Destination PACS AE Title
  --dest-host    Destination PACS Host/IP
  --dest-port    Destination PACS DICOM port

Optional:
  --username     Source Orthanc username (if any)
  --password     Source Orthanc password (if any)
  --modality-name  Temporary modality name to register on the source (default: MOVER-CLI)
                    Letters/digits/dashes only (no "_") — some older Orthanc versions
                    reject underscores in modality names.
  --concurrency  How many cases to send at once (default: 6). A slow/stuck case
                 doesn't block the others.
  --dest-rest-url  REST API URL of the destination Orthanc, used to get a real yes/no
                   answer (by comparing image counts) instead of guessing when a case's
                   job history entry on the source gets evicted before we can see
                   whether it truly finished. Defaults automatically to
                   http://<dest-host>:8042 - only pass this if the destination's REST
                   port is different.
  --dest-rest-username  Destination REST username (if any)
  --dest-rest-password  Destination REST password (if any)
  --help         Show this message

While running (in a real terminal):
  p / r   Pause / resume sending (in-flight cases finish either way)
  n / b   After one date range finishes: move on to the next / previous
          range of the same number of days, and start over. Any other key
          at that point stops for good.

Example:
  node movestudy.js --source http://192.168.250.110/orthanc \\
    --from 2026-01-01 --to 2026-12-31 \\
    --dest-aet REMOTEPACS --dest-host 10.0.0.5 --dest-port 104
`);
}

function buildAuthHeader(username, password) {
  if (!username && !password) return null;
  const token = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  return `Basic ${token}`;
}

function normalizeOrthancUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function toDicomDate(isoDate) {
  return String(isoDate || '').replace(/-/g, '');
}

async function orthancFetch(orthancUrl, authHeader, pathname, options = {}) {
  return fetch(`${orthancUrl}${pathname}`, {
    ...options,
    headers: {
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function findStudies(orthancUrl, authHeader, fromDate, toDate) {
  const res = await orthancFetch(orthancUrl, authHeader, '/tools/find', {
    method: 'POST',
    body: JSON.stringify({
      Level: 'Study',
      Query: { StudyDate: `${toDicomDate(fromDate)}-${toDicomDate(toDate)}` },
      Expand: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Orthanc returned an error (${res.status}): ${text || res.statusText}`);
  }
  const studies = await res.json();
  return studies.map((s) => {
    const tags = s.MainDicomTags || {};
    const patientTags = s.PatientMainDicomTags || {};
    return {
      id: s.ID,
      patientName: patientTags.PatientName || '',
      patientId: patientTags.PatientID || '',
      accessionNumber: tags.AccessionNumber || '',
      studyDate: tags.StudyDate || '',
      studyDescription: tags.StudyDescription || '',
    };
  });
}

async function ensureModalityRegistered(orthancUrl, authHeader, name, aet, host, port) {
  const res = await orthancFetch(orthancUrl, authHeader, `/modalities/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ AET: aet, Host: host, Port: Number(port), Manufacturer: 'Generic' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to register the destination PACS (${res.status}): ${text || res.statusText}`);
  }
}

// Store is async (Synchronous:false) - the POST just starts a job on the source and
// returns right away, then we poll /jobs/{id} for the result. Keeps a slow transfer
// from holding the HTTP connection open long enough to hit an nginx 504.
const JOB_POLL_INTERVAL_MS = 1000;

// Turns a checkStudyCompleteOnDestination() result into a short suffix for messages,
// so every outcome can say what was actually found at the destination.
function formatDestinationCheckSuffix(result) {
  if (!result) return " - couldn't check the destination to make sure";
  if (result.complete) return ` - confirmed ${result.actualCount}/${result.expectedCount} image(s) at the destination`;
  if (result.found === false) return " - the destination doesn't have this case at all";
  return ` - the destination only has ${result.actualCount} of ${result.expectedCount} image(s)`;
}

// Retries a destination check only when it couldn't be reached at all (null) - a real
// answer, complete or not, is trusted right away. Stops a momentary network blip from
// turning into a false "failed".
async function checkDestinationWithRetry(checkFn) {
  let result = null;
  for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
    result = await checkFn().catch(() => null);
    if (result !== null) return result;
    if (attempt < STORE_MAX_ATTEMPTS) await sleep(STORE_RETRY_DELAY_MS);
  }
  return null;
}

// verifyIfEvicted (optional) checks the destination directly once we've lost track of
// the job (see below) - true/false/null, same as checkStudyCompleteOnDestination.
//
// No timeout on the wait itself: we sit here until Orthanc reports Success/Failure.
// Orthanc's own DICOM timeout is what catches a truly stuck transfer, and since cases
// run with concurrency, a slow one just keeps its own worker busy without holding up
// the rest.
async function waitForJobCompletion(orthancUrl, authHeader, jobId, verifyIfEvicted) {
  for (;;) {
    // A poll can fail transiently (a bad moment for a reverse proxy, a dropped
    // connection) without the job itself having failed - treat that as "still
    // running" and try again, except for 404, handled separately below.
    let jobInfo = null;
    let notFound = false;
    try {
      const res = await orthancFetch(orthancUrl, authHeader, `/jobs/${encodeURIComponent(jobId)}`);
      if (res.ok) {
        jobInfo = await res.json();
      } else if (res.status === 404) {
        notFound = true;
      }
    } catch (err) {
      // network-level hiccup while polling - fall through and retry
    }

    if (notFound) {
      // Orthanc only evicts finished jobs from its job history (JobsHistorySize,
      // default 10) - a job still running is never evicted. So if this job has
      // vanished, it must have already finished and aged out because enough other
      // jobs finished after it. We can't ask Orthanc directly any more at this point.
      if (verifyIfEvicted) {
        const result = await checkDestinationWithRetry(verifyIfEvicted);
        if (result && result.complete) {
          return { verifiedOnDestination: true, actualCount: result.actualCount, expectedCount: result.expectedCount };
        }
        if (result && result.complete === false) {
          if (!result.found) {
            throw new Error("Lost track of this job, and the destination doesn't have this case at all - please retry");
          }
          throw new Error(`Lost track of this job, and the destination only has ${result.actualCount} of ${result.expectedCount} image(s) - please retry`);
        }
        // null = the check itself failed - treat this the same as not having
        // verification configured at all.
      }
      return { assumedSuccessJobEvicted: true };
    }

    if (jobInfo) {
      if (jobInfo.State === 'Success') {
        const content = jobInfo.Content || {};
        if (typeof content.FailedInstancesCount === 'number' && content.FailedInstancesCount > 0) {
          const suffix = verifyIfEvicted ? formatDestinationCheckSuffix(await checkDestinationWithRetry(verifyIfEvicted)) : '';
          throw new Error(`${content.FailedInstancesCount} image(s) didn't make it${suffix}`);
        }
        return content;
      }
      if (jobInfo.State === 'Failure') {
        const suffix = verifyIfEvicted ? formatDestinationCheckSuffix(await checkDestinationWithRetry(verifyIfEvicted)) : '';
        throw new Error(`${jobInfo.ErrorDescription || "Sending failed on the source Orthanc"}${suffix}`);
      }
      if (jobInfo.State === 'Cancelled' || jobInfo.State === 'Paused') {
        const suffix = verifyIfEvicted ? formatDestinationCheckSuffix(await checkDestinationWithRetry(verifyIfEvicted)) : '';
        throw new Error(`Sending was ${jobInfo.State.toLowerCase()} on the source Orthanc${suffix}`);
      }
    }

    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

// Number of instances (images) a study has, or null if it couldn't be determined.
async function getInstanceCount(orthancUrl, authHeader, studyId) {
  try {
    const res = await orthancFetch(orthancUrl, authHeader, `/studies/${encodeURIComponent(studyId)}/instances`);
    if (!res.ok) return null;
    const instances = await res.json().catch(() => null);
    return Array.isArray(instances) ? instances.length : null;
  } catch (err) {
    return null;
  }
}

// Checks not just whether a study exists on the destination, but whether it has the
// SAME NUMBER OF INSTANCES as the source (a partial transfer would otherwise look
// "present" but actually be incomplete). Matches by Accession Number when there is
// one; if the case has none at all (so it could never be found this way), falls back
// to StudyInstanceUID instead - the one identifier guaranteed not to collide - rather
// than giving up and reporting these cases as permanently unverifiable.
// Returns null if the check itself couldn't be done, otherwise one of:
//   { complete: true }
//   { complete: false, found: false }                             - not there at all
//   { complete: false, found: true, actualCount, expectedCount }   - present but short
async function checkStudyCompleteOnDestination(sourceUrl, sourceAuthHeader, sourceStudyId, destRestUrl, destAuthHeader, accessionNumber) {
  const expectedCount = await getInstanceCount(sourceUrl, sourceAuthHeader, sourceStudyId);
  if (expectedCount === null) return null; // can't tell what "complete" even means here

  async function findByStudyInstanceUid() {
    const sourceStudyRes = await orthancFetch(sourceUrl, sourceAuthHeader, `/studies/${encodeURIComponent(sourceStudyId)}`);
    if (!sourceStudyRes.ok) return null;
    const sourceStudy = await sourceStudyRes.json().catch(() => null);
    const studyInstanceUid = sourceStudy && sourceStudy.MainDicomTags && sourceStudy.MainDicomTags.StudyInstanceUID;
    if (!studyInstanceUid) return null;

    const res = await orthancFetch(destRestUrl, destAuthHeader, '/tools/find', {
      method: 'POST',
      body: JSON.stringify({ Level: 'Study', Query: { StudyInstanceUID: studyInstanceUid } }),
    });
    if (!res.ok) return null;
    const matches = await res.json().catch(() => null);
    return Array.isArray(matches) ? matches : null;
  }

  try {
    let matches = null;

    if (accessionNumber) {
      const res = await orthancFetch(destRestUrl, destAuthHeader, '/tools/find', {
        method: 'POST',
        body: JSON.stringify({ Level: 'Study', Query: { AccessionNumber: accessionNumber } }),
      });
      if (!res.ok) return null;
      matches = await res.json().catch(() => null);
      if (!Array.isArray(matches)) return null;

      // XN ซ้ำที่ปลายทาง (เจอมากกว่า 1 เคส) - เชื่อ matches[0] เดาไม่ได้ว่าอันไหนถูก
      // fallback ไปเทียบด้วย StudyInstanceUID แทนเพื่อความแม่นยำ
      if (matches.length > 1) {
        matches = await findByStudyInstanceUid();
        if (!Array.isArray(matches)) return null;
      }
    } else {
      matches = await findByStudyInstanceUid();
      if (!Array.isArray(matches)) return null;
    }

    if (matches.length === 0) return { complete: false, found: false };

    const actualCount = await getInstanceCount(destRestUrl, destAuthHeader, matches[0]);
    if (actualCount === null) return null;
    if (actualCount >= expectedCount) return { complete: true, actualCount, expectedCount };
    return { complete: false, found: true, actualCount, expectedCount };
  } catch (err) {
    return null;
  }
}

async function storeResourcesToModality(orthancUrl, authHeader, name, resourceIds, verifyIfEvicted) {
  const res = await orthancFetch(orthancUrl, authHeader, `/modalities/${encodeURIComponent(name)}/store`, {
    method: 'POST',
    body: JSON.stringify({ Resources: resourceIds, Synchronous: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let reason = text || res.statusText;
    try {
      const parsed = JSON.parse(text);
      reason = parsed.Details || parsed.Message || reason;
    } catch (err) {
      // not JSON - keep the raw text
    }
    throw new Error(`Failed to start sending to the destination PACS (${res.status}): ${reason}`);
  }
  const job = await res.json().catch(() => ({}));
  if (!job.ID) {
    throw new Error('Orthanc did not return a job ID for the asynchronous store request');
  }
  return waitForJobCompletion(orthancUrl, authHeader, job.ID, verifyIfEvicted);
}

// DICOM dates come back as plain "YYYYMMDD" (e.g. "20260701") - add dashes for display.
function formatDicomDate(yyyymmdd) {
  const s = String(yyyymmdd || '');
  if (s.length !== 8) return s || 'UNKNOWN';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// Every calendar date (YYYY-MM-DD) from fromIso to toIso, inclusive. Uses UTC
// internally so it can't be thrown off by DST changes.
function enumerateDates(fromIso, toIso) {
  const dates = [];
  const start = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Shifts a YYYY-MM-DD date by a number of days (negative = earlier). UTC-based, same
// reasoning as enumerateDates.
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Number of days spanned by [fromIso, toIso], inclusive (e.g. 15 for a 15-day window).
function windowLengthDays(fromIso, toIso) {
  const start = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STORE_MAX_ATTEMPTS = 3;
const STORE_RETRY_DELAY_MS = 1000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DEST_REST_PORT = 8042;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Local (system) time, not UTC - e.g. "2026-09-09 23:29:43"
function formatLocalDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// CRLF so it reads right in Windows Notepad. Written right away (not buffered), so
// the file can be tailed mid-run - useful for an overnight run checked on now and then.
function appendLogLine(filePath, line) {
  fs.appendFileSync(filePath, `[${formatLocalDateTime(new Date())}] ${line}\r\n`, 'utf8');
}

// Writes the header up front (overwriting any previous run for this date range) -
// everything else gets appended line by line via appendLogLine as it happens.
function initLogFile({ startedAt, orthancUrl, destAet, destHost, destPort, from, to }) {
  const fileName = `movestudy-log-${from}_to_${to}.txt`;
  const filePath = path.join(__dirname, fileName);
  const header = [
    `Run started: ${formatLocalDateTime(startedAt)}`,
    `Source: ${orthancUrl}`,
    `Destination: AET=${destAet} Host=${destHost} Port=${destPort}`,
    `Date range: ${from} to ${to}`,
    '',
  ];
  fs.writeFileSync(filePath, header.join('\r\n') + '\r\n', 'utf8');
  return filePath;
}

async function main() {
  const startedAt = new Date();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const required = ['source', 'from', 'to', 'dest-aet', 'dest-host', 'dest-port'];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0) {
    console.log("Some values are missing - I'll ask for them one by one (press Enter to skip optional ones)\n");
    await fillMissingArgsInteractively(args);
    console.log('');

    const stillMissing = required.filter((k) => !args[k]);
    if (stillMissing.length > 0) {
      console.error(`Still missing required options: ${stillMissing.map((k) => `--${k}`).join(', ')}\n`);
      process.exit(1);
    }
  }

  const orthancUrl = normalizeOrthancUrl(args.source);
  const authHeader = buildAuthHeader(args.username, args.password);
  const modalityName = args['modality-name'] || 'MOVER-CLI';
  const destAet = args['dest-aet'];
  const destHost = args['dest-host'];
  const destPort = args['dest-port'];
  const concurrency = Math.max(1, Number(args.concurrency) || DEFAULT_CONCURRENCY);

  // Defaults to the destination host on Orthanc's standard REST port, so this works
  // without needing --dest-rest-url on the command line.
  const destRestUrl = normalizeOrthancUrl(args['dest-rest-url'] || `http://${destHost}:${DEFAULT_DEST_REST_PORT}`);
  const destRestAuthHeader = buildAuthHeader(args['dest-rest-username'], args['dest-rest-password']);
  const windowSize = windowLengthDays(args.from, args.to);

  console.log(`Started: ${formatLocalDateTime(startedAt)}`);
  console.log(`Source: ${orthancUrl}`);
  console.log(`Destination: AET=${destAet} Host=${destHost} Port=${destPort}\n`);

  console.log(`Registering the destination as modality "${modalityName}" on the source...`);
  await ensureModalityRegistered(orthancUrl, authHeader, modalityName, destAet, destHost, destPort);
  console.log('Registered successfully\n');

  // "p"/"r" pause/resume while sending; "n"/"b" (only offered between ranges) move to
  // the next/previous window and start over. `awaitingNav` switches which pair the
  // same key listener responds to.
  let paused = false;
  let awaitingNav = false;
  let navChoice = null;
  const canListenForKeys = process.stdin.isTTY;
  if (canListenForKeys) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (str) => {
      if (awaitingNav) {
        navChoice = str === 'n' || str === 'b' ? str : 'stop';
        return;
      }
      if (str === 'p' && !paused) {
        paused = true;
        console.log('\n[Paused] Finishing in-flight case(s), no new ones will start. Press "r" to resume.');
      } else if (str === 'r' && paused) {
        paused = false;
        console.log('[Resumed] Continuing...');
      }
    });
  }

  async function runRange(fromDate, toDate) {
    console.log(`Date range: ${fromDate} to ${toDate}`);
    const logPath = initLogFile({ startedAt, orthancUrl, destAet, destHost, destPort, from: fromDate, to: toDate });
    console.log(`Log: ${logPath}\n`);
    console.log(`Sending up to ${concurrency} case(s) at a time, one day at a time (search, send, then move to the next day).`);
    console.log(canListenForKeys ? 'Press "p" to pause, "r" to resume.\n' : '');

    // One day at a time instead of the whole range in one request - a wide range can
    // be slow enough to hit the same 504 problem sending used to have. Each day is now
    // sent as soon as it's found, rather than searching every day first and sending
    // everything as one big batch at the end.
    const searchDates = enumerateDates(fromDate, toDate);
    const searchFailures = [];
    let grandTotal = 0;
    let successCount = 0;
    let failedCount = 0;
    const failedList = [];

    async function processStudy(study, dayTotal, seq) {
      const label = `[${formatDicomDate(study.studyDate)}] HN:${study.patientId || '-'} XN:${study.accessionNumber || '-'}`;

      const verifyIfEvicted = () =>
        checkStudyCompleteOnDestination(orthancUrl, authHeader, study.id, destRestUrl, destRestAuthHeader, study.accessionNumber);

      let lastErr;
      let storeResult;
      for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
        try {
          storeResult = await storeResourcesToModality(orthancUrl, authHeader, modalityName, [study.id], verifyIfEvicted);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const isConnError = /fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(err.message);
          if (!isConnError || attempt === STORE_MAX_ATTEMPTS) break;
          await sleep(STORE_RETRY_DELAY_MS);
        }
      }

      if (lastErr) {
        failedCount += 1;
        failedList.push({ date: formatDicomDate(study.studyDate), ...study, message: lastErr.message });
        console.log(`  [${seq}/${dayTotal}] x ${label} - ${lastErr.message}`);
        appendLogLine(logPath, `FAILED [${seq}/${dayTotal}] ${label} - ${lastErr.message}`);
      } else {
        // Orthanc not throwing isn't enough on its own - always check the real
        // destination too, and reuse the eviction-path check above if we already did
        // one.
        const verify = storeResult && storeResult.verifiedOnDestination
          ? { complete: true, actualCount: storeResult.actualCount, expectedCount: storeResult.expectedCount }
          : await checkDestinationWithRetry(() =>
              checkStudyCompleteOnDestination(orthancUrl, authHeader, study.id, destRestUrl, destRestAuthHeader, study.accessionNumber)
            );

        if (!verify || verify.complete === false) {
          // Disagreed with Orthanc, or couldn't be checked at all - either way, don't
          // just trust Orthanc's own report.
          failedCount += 1;
          const message = `Orthanc said this went through fine${formatDestinationCheckSuffix(verify)}`;
          failedList.push({ date: formatDicomDate(study.studyDate), ...study, message });
          console.log(`  [${seq}/${dayTotal}] x ${label} - ${message}`);
          appendLogLine(logPath, `FAILED [${seq}/${dayTotal}] ${label} - ${message}`);
        } else {
          successCount += 1;
          const verifiedSuffix = formatDestinationCheckSuffix(verify);
          console.log(`  [${seq}/${dayTotal}] OK ${label}${verifiedSuffix}`);
          appendLogLine(logPath, `OK [${seq}/${dayTotal}] ${label}${verifiedSuffix}`);
        }
      }
    }

    for (const day of searchDates) {
      let dayStudies = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
        try {
          dayStudies = await findStudies(orthancUrl, authHeader, day, day);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          await sleep(STORE_RETRY_DELAY_MS);
        }
      }
      if (lastErr) {
        console.error(`  ${day}: search failed - ${lastErr.message}`);
        searchFailures.push({ date: day, message: lastErr.message });
        appendLogLine(logPath, `SEARCH FAILED ${day} - ${lastErr.message}`);
        continue;
      }

      appendLogLine(logPath, `SEARCH ${day}: ${dayStudies.length} case(s) found`);
      if (dayStudies.length === 0) {
        console.log(`  ${day}: 0 case(s) found`);
        continue;
      }
      console.log(`\n  ${day}: ${dayStudies.length} case(s) found - sending...`);
      grandTotal += dayStudies.length;

      // Same concurrency-limited worker pool as before, just scoped to one day's
      // cases at a time instead of the whole range's.
      let nextIndex = 0;
      let dayDone = 0;
      async function worker() {
        while (nextIndex < dayStudies.length) {
          while (paused) {
            await sleep(200);
          }
          if (nextIndex >= dayStudies.length) break;
          const study = dayStudies[nextIndex];
          nextIndex += 1;
          // Grab this case's own number right now, before processStudy's destination
          // check can await - otherwise a slower case can print whatever number is
          // current by the time it gets there, causing duplicate/out-of-order numbers.
          dayDone += 1;
          const seq = dayDone;
          await processStudy(study, dayStudies.length, seq);
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      paused = false;
    }

    if (searchFailures.length > 0) {
      console.log(`\nWarning: could not search ${searchFailures.length} day(s) - their cases were NOT included and were not moved. Re-run for just those dates.`);
      for (const f of searchFailures) {
        console.log(`  - ${f.date}: ${f.message}`);
      }
    }

    console.log(`\nDone - moved ${grandTotal} case(s) total (${successCount} succeeded, ${failedCount} failed)`);

    if (failedList.length > 0) {
      console.log('\nFailed cases:');
      for (const f of failedList) {
        console.log(`  - [${f.date}] HN:${f.patientId || '-'} XN:${f.accessionNumber || '-'} - ${f.message}`);
      }
    }

    appendLogLine(logPath, `Result: ${grandTotal} case(s) total, ${successCount} succeeded, ${failedCount} failed`);
    if (searchFailures.length > 0) {
      fs.appendFileSync(logPath, '\r\n', 'utf8');
      appendLogLine(logPath, 'Days that could NOT be searched (their cases were not included/moved at all):');
      for (const f of searchFailures) {
        fs.appendFileSync(logPath, `  - ${f.date} - ${f.message}\r\n`, 'utf8');
      }
    }
    if (failedList.length > 0) {
      fs.appendFileSync(logPath, '\r\n', 'utf8');
      appendLogLine(logPath, 'Failed cases:');
      for (const f of failedList) {
        fs.appendFileSync(logPath, `  - [${f.date}] XN:${f.accessionNumber || '-'} HN:${f.patientId || '-'} - ${f.message}\r\n`, 'utf8');
      }
    }
    console.log(`\nLog file: ${logPath}`);
  }

  let currentFrom = args.from;
  let currentTo = args.to;

  for (;;) {
    await runRange(currentFrom, currentTo);

    if (!canListenForKeys) break;

    const nextFrom = addDays(currentTo, 1);
    const nextTo = addDays(currentTo, windowSize);
    const prevFrom = addDays(currentFrom, -windowSize);
    const prevTo = addDays(currentFrom, -1);
    console.log(
      `\nPress "n" for the next ${windowSize} day(s) (${nextFrom} to ${nextTo}), ` +
      `"b" for the previous ${windowSize} day(s) (${prevFrom} to ${prevTo}), or any other key to stop.`
    );

    navChoice = null;
    awaitingNav = true;
    while (navChoice === null) {
      await sleep(200);
    }
    awaitingNav = false;

    if (navChoice === 'n') {
      currentFrom = nextFrom;
      currentTo = nextTo;
    } else if (navChoice === 'b') {
      currentFrom = prevFrom;
      currentTo = prevTo;
    } else {
      break;
    }
  }

  if (canListenForKeys) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
