// server.js (ESM)
import express from "express";
import { WebUntis } from "webuntis";
import { DateTime } from "luxon";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function parseDateISO(iso) {
  // iso = "YYYY-MM-DD"
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Bad date: ${iso}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// helper: normalize raw Untis time into minutes
function normalizeLessonTime(raw, fieldName = "") {
  if (raw == null)
    return { minutes: null, raw, field: fieldName, reason: "null" };

  // "HH:MM" or "HH:MM:SS"
  if (typeof raw === "string" && raw.includes(":")) {
    const parts = raw.split(":").map(Number);
    if (parts.length >= 2 && !parts.some(Number.isNaN)) {
      return {
        minutes: parts[0] * 60 + parts[1],
        raw,
        field: fieldName,
        reason: "HH:MM string",
      };
    }
  }

  const v = Number(raw);
  if (Number.isNaN(v))
    return { minutes: null, raw, field: fieldName, reason: "NaN" };

  // HHMM or HHMMSS style
  if (v >= 100 && v <= 235959) {
    const s = String(Math.floor(v));
    if (s.length <= 4) {
      const hh = Number(s.padStart(4, "0").slice(0, 2));
      const mm = Number(s.padStart(4, "0").slice(2, 4));
      if (hh < 24 && mm < 60)
        return { minutes: hh * 60 + mm, raw, field: fieldName, reason: "HHMM" };
    } else {
      const hh = Number(s.padStart(6, "0").slice(0, 2));
      const mm = Number(s.padStart(6, "0").slice(2, 4));
      if (hh < 24 && mm < 60)
        return {
          minutes: hh * 60 + mm,
          raw,
          field: fieldName,
          reason: "HHMMSS",
        };
    }
  }

  // plausible minutes
  if (v >= 0 && v <= 1440)
    return { minutes: Math.floor(v), raw, field: fieldName, reason: "minutes" };

  // seconds since midnight
  if (v <= 86400)
    return {
      minutes: Math.floor(v / 60),
      raw,
      field: fieldName,
      reason: "seconds",
    };

  // ms since midnight
  return {
    minutes: Math.floor(v / 60000),
    raw,
    field: fieldName,
    reason: "ms",
  };
}

/**
 * Make start/end array for ICS from a lesson date and a minutes value (minutes-after-midnight).
 * Accepts l.date in forms like 20250915 (string/number) or JS Date.
 */
function eventTimeFromLessonDateAndMinutes(dateValue, minutes) {
  if (minutes == null) return null;
  let year, month, day;
  if (typeof dateValue === "string" && /^\d{8}$/.test(dateValue)) {
    year = Number(dateValue.slice(0, 4));
    month = Number(dateValue.slice(4, 6));
    day = Number(dateValue.slice(6, 8));
  } else if (typeof dateValue === "number" && String(dateValue).length === 8) {
    const s = String(dateValue);
    year = Number(s.slice(0, 4));
    month = Number(s.slice(4, 6));
    day = Number(s.slice(6, 8));
  } else if (dateValue instanceof Date) {
    year = dateValue.getFullYear();
    month = dateValue.getMonth() + 1;
    day = dateValue.getDate();
  } else {
    // fallback to today
    const d = new Date();
    year = d.getFullYear();
    month = d.getMonth() + 1;
    day = d.getDate();
  }

  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [year, month, day, h, m];
}

function makeUntisInstance() {
  return new WebUntis(
    process.env.UNTIS_SCHOOL,
    process.env.UNTIS_USERNAME,
    process.env.UNTIS_PASSWORD,
    process.env.UNTIS_SERVER
  );
}

// iso = "YYYY-MM-DD"
function toUntisYMD(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return y * 10000 + m * 100 + d; // 20250915 -> 20250915 (number)
}

async function findSchoolyearForDate(untis, dateIso) {
  // returns schoolyear object that contains the date, or null
  const ymd = toUntisYMD(dateIso);
  const years = await untis.getSchoolyears();
  return (
    years.find((y) => {
      const start = Number(y.startDate); // e.g. 20240901
      const end = Number(y.endDate);
      return start <= ymd && ymd <= end;
    }) || null
  );
}

// findSchoolyearContainingClass: requires an already logged-in `untis` instance
async function findSchoolyearContainingClass(untis, classId) {
  const years = await untis.getSchoolyears();
  for (const y of years) {
    try {
      const classes = await untis.getClasses(undefined, y.id);
      if (
        Array.isArray(classes) &&
        classes.some((c) => Number(c.id) === Number(classId))
      ) {
        return y; // return the whole schoolyear object (id, startDate, endDate, ...)
      }
    } catch (err) {
      // ignore per-year errors but log for debug
      console.warn(
        `Warning: getClasses failed for schoolyear ${y.id}:`,
        err && err.message ? err.message : err
      );
    }
  }
  return null;
}

// GET /classes?schoolyear=123  OR  /classes?date=2025-09-15
app.get("/classes", async (req, res) => {
  const { schoolyear, date } = req.query;
  const untis = makeUntisInstance();
  try {
    await untis.login();

    let syId = schoolyear ? Number(schoolyear) : undefined;
    if (!syId && date) {
      const found = await findSchoolyearForDate(untis, date);
      if (found) syId = found.id;
    }

    // call getClasses(validateSession?, schoolyearId)
    // pass undefined for validateSession to use default, and provide schoolyearId as second param
    const classes = await untis.getClasses(undefined, syId);
    await untis.logout();
    res.json({ schoolyear: syId ?? null, classes });
  } catch (err) {
    try {
      await untis.logout();
    } catch (e) {}
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// GET /ics/class
// Generate ICS for a class id. Example: /ics/class?id=41213&start=2025-09-16&end=2025-09-20&schoolyear=45
app.get("/ics/class", async (req, res) => {
  const { id, start, end, schoolyear, schoolyearDate } = req.query;
  if (!id || !start || !end)
    return res.status(400).send("Missing id,start,end");

  const classId = Number(id);
  if (Number.isNaN(classId)) return res.status(400).send("id must be numeric");

  const untis = makeUntisInstance();
  try {
    await untis.login();

    // If user supplied a schoolyear id, confirm class exists there
    let syId = schoolyear ? Number(schoolyear) : undefined;
    if (syId) {
      const classesInYear = await untis.getClasses(undefined, syId);
      if (
        !Array.isArray(classesInYear) ||
        !classesInYear.some((c) => Number(c.id) === classId)
      ) {
        // not found in provided schoolyear -> try to auto-locate
        console.log(
          `Class ${classId} not found in schoolyear ${syId}. Attempting auto-detect...`
        );
        const foundYear = await findSchoolyearContainingClass(untis, classId);
        if (foundYear) {
          console.log(
            `Auto-detect: class ${classId} found in schoolyear ${foundYear.id}`
          );
          syId = foundYear.id;
        } else {
          await untis.logout();
          return res
            .status(404)
            .send(
              `Class ${classId} not found in schoolyear ${schoolyear} or in any schoolyear.`
            );
        }
      }
    } else if (schoolyearDate) {
      // if user gave a date that should lie in the desired year, find that year
      const found = await findSchoolyearForDate(untis, schoolyearDate);
      if (found) syId = found.id;
    } else {
      // no schoolyear provided -> try to auto-detect which schoolyear contains the class
      const foundYear = await findSchoolyearContainingClass(untis, classId);
      if (foundYear) {
        syId = foundYear.id;
        console.log(
          `Auto-detect: class ${classId} is in schoolyear ${syId} (${foundYear.startDate}-${foundYear.endDate})`
        );
      } else {
        console.log(
          `Auto-detect failed: class ${classId} not found in any schoolyear`
        );
        // still proceed — sometimes getTimetableForRange works even if the class isn't registered in classes(...) for that year
      }
    }

    // At this point syId is the best candidate (or undefined)
    // OPTIONAL: If you want you can return info to the client:
    console.log("Using schoolyear id:", syId ?? "none");

    // --- allow omitting start/end: auto-detect full schoolyear for the class ---
    let startIso = start,
      endIso = end;
    if (!startIso || !endIso) {
      // we need an untis instance to detect the year — we already have `untis` logged in above
      let sy = undefined;
      // prefer provided schoolyear if present
      if (schoolyear) {
        const years = await untis.getSchoolyears();
        sy = years.find((y) => Number(y.id) === Number(schoolyear));
      }
      // otherwise try to find the year that contains the class
      if (!sy) sy = await findSchoolyearContainingClass(untis, classId);
      // fallback: find year for a known date (e.g. today)
      if (!sy) {
        const d = new Date();
        const isoToday = `${d.getFullYear()}-${String(
          d.getMonth() + 1
        ).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        sy = await findSchoolyearForDate(untis, isoToday);
      }
      if (!sy) {
        // if still not found, error out
        await untis.logout();
        return res
          .status(404)
          .send(
            "Could not determine schoolyear for the class (provide start/end or schoolyear param)."
          );
      }

      const fmt = (v) => {
        if (!v && v !== 0) return null;
        if (v instanceof Date)
          return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(
            2,
            "0"
          )}-${String(v.getDate()).padStart(2, "0")}`;
        if (typeof v === "number") v = String(v);
        if (typeof v === "string") {
          v = v.trim();
          if (/^\d{8}$/.test(v))
            return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
          if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
          const m = /^(\d{4}-\d{2}-\d{2})[T\s]/.exec(v);
          if (m) return m[1];
        }
        return null;
      };

      startIso = startIso || fmt(sy.startDate);
      endIso = endIso || fmt(sy.endDate);
    }

    // now parse actual Dates
    const s = parseDateISO(startIso);
    const e = parseDateISO(endIso);

    const lessons = await untis.getTimetableForRange(s, e, classId, 1);

    const ELEMENT_TYPE_CLASS = 1;

    try {
      await untis.login();

      console.log("DEBUG: fetching timetable", {
        classId,
        start: s.toISOString(),
        end: e.toISOString(),
        elementType: ELEMENT_TYPE_CLASS,
      });

      const lessons = await untis.getTimetableForRange(
        s,
        e,
        classId,
        ELEMENT_TYPE_CLASS
      );

      // --- filter out unwanted subjects if excludeSubjects param provided ---
      // excludeSubjects expected as comma-separated numeric ids in query string
      const excludeRaw = (
        req.query.excludeSubjects ||
        req.query.exclude ||
        ""
      ).toString();
      const excludeSet = new Set(
        excludeRaw
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => Number(x))
          .filter((n) => !Number.isNaN(n))
      );
      if (excludeSet.size > 0) {
        const before = Array.isArray(lessons) ? lessons.length : 0;
        lessons = (lessons || []).filter((l) => {
          const sid = l.su && l.su[0] && l.su[0].id ? Number(l.su[0].id) : null;
          return sid == null ? true : !excludeSet.has(sid);
        });
        console.log(
          `FILTER-DEBUG: excluded ${
            before - lessons.length
          } lessons by subjects [${[...excludeSet].join(",")}]`
        );
      }

      console.log(
        "DEBUG: lessons length",
        Array.isArray(lessons) ? lessons.length : typeof lessons
      );

      if (!lessons || lessons.length === 0) {
        // try small fallback window: one week from start
        const oneWeek = new Date(s);
        oneWeek.setDate(oneWeek.getDate() + 7);
        console.log(
          "DEBUG: trying fallback 7-day window",
          s.toISOString(),
          oneWeek.toISOString()
        );
        const fallback = await untis.getTimetableForRange(
          s,
          oneWeek,
          classId,
          ELEMENT_TYPE_CLASS
        );
        console.log(
          "DEBUG: fallback lessons length",
          Array.isArray(fallback) ? fallback.length : typeof fallback
        );
        // if fallback has items, replace lessons with fallback; else continue with original (will return empty ICS)
        if (Array.isArray(fallback) && fallback.length > 0) {
          console.log("DEBUG: using fallback result");
          // continue with fallback
          // (we still let lessons be fallback)
          lessons.length = 0;
          lessons.push(...fallback);
        }
      }

      // build events
      const events = (lessons || []).map((l, idx) => {
        const candidates = [
          l.startTime,
          l.start,
          l.startdate,
          l.startDateTime,
          l.startTimestamp,
          l.begin,
          l.beginTime,
          l.time,
          l.from,
          l.fromTime,
        ];

        function pickFirst(...vals) {
          for (const v of vals) if (v !== undefined && v !== null) return v;
          return null;
        }

        function debugNormalize(raw, fieldName) {
          if (raw == null)
            return { minutes: null, raw, field: fieldName, reason: "null" };

          // "HH:MM" or "HH:MM:SS"
          if (typeof raw === "string" && raw.includes(":")) {
            const parts = raw.split(":").map(Number);
            if (parts.length >= 2 && !parts.some(Number.isNaN)) {
              return {
                minutes: parts[0] * 60 + parts[1],
                raw,
                field: fieldName,
                reason: "HH:MM string",
              };
            }
          }

          const v = Number(raw);
          if (Number.isNaN(v))
            return { minutes: null, raw, field: fieldName, reason: "NaN" };

          // Prefer HHMM / HHMMSS style if the number could be a clock time (e.g. 800, 1400, 112000)
          // Accept values in range 100..235959 as candidate HHMM/HHMMSS.
          if (v >= 100 && v <= 235959) {
            const s = String(Math.floor(v));
            // short <=4 digits -> treat as HHMM (pad to 4)
            if (s.length <= 4) {
              const padded4 = s.padStart(4, "0"); // HHMM
              const hh = Number(padded4.slice(0, 2));
              const mm = Number(padded4.slice(2, 4));
              if (
                !Number.isNaN(hh) &&
                !Number.isNaN(mm) &&
                hh < 24 &&
                mm < 60
              ) {
                return {
                  minutes: hh * 60 + mm,
                  raw,
                  field: fieldName,
                  reason: "HHMM numeric (short)",
                };
              }
            } else {
              // longer -> HHMMSS style (pad to 6)
              const padded6 = s.padStart(6, "0");
              const hh = Number(padded6.slice(0, 2));
              const mm = Number(padded6.slice(2, 4));
              if (
                !Number.isNaN(hh) &&
                !Number.isNaN(mm) &&
                hh < 24 &&
                mm < 60
              ) {
                return {
                  minutes: hh * 60 + mm,
                  raw,
                  field: fieldName,
                  reason: "HHMMSS numeric (long)",
                };
              }
            }
          }

          // If it wasn't HHMM/HHMMSS, treat plausible minute counts next (0..1440)
          if (v >= 0 && v <= 24 * 60) {
            return {
              minutes: Math.floor(v),
              raw,
              field: fieldName,
              reason: "minutes",
            };
          }

          // seconds since midnight
          if (v > 24 * 60 && v <= 24 * 60 * 60) {
            return {
              minutes: Math.floor(v / 60),
              raw,
              field: fieldName,
              reason: "seconds",
            };
          }

          // milliseconds since midnight
          if (v > 24 * 60 * 60) {
            return {
              minutes: Math.floor(v / 60000),
              raw,
              field: fieldName,
              reason: "milliseconds",
            };
          }

          return {
            minutes: null,
            raw,
            field: fieldName,
            reason: "no-heuristic",
          };
        }

        // pick start
        let chosen = null;
        const names = [
          "startTime",
          "start",
          "startdate",
          "startDateTime",
          "startTimestamp",
          "begin",
          "beginTime",
          "time",
          "from",
          "fromTime",
        ];
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const res = debugNormalize(cand, names[i]);
          if (res.minutes != null) {
            chosen = res;
            break;
          }
        }
        if (!chosen) {
          const res1 = debugNormalize(
            l.startTime ?? l.start,
            "startTime|start"
          );
          if (res1.minutes != null) chosen = res1;
        }
        const startMin = chosen ? chosen.minutes : null;

        // pick end
        const endCandidates = [
          l.endTime,
          l.end,
          l.enddate,
          l.endDateTime,
          l.endTimestamp,
          l.to,
          l.toTime,
        ];
        let chosenEnd = null;
        const endNames = [
          "endTime",
          "end",
          "enddate",
          "endDateTime",
          "endTimestamp",
          "to",
          "toTime",
        ];
        for (let i = 0; i < endCandidates.length; i++) {
          const res = debugNormalize(endCandidates[i], endNames[i]);
          if (res.minutes != null) {
            chosenEnd = res;
            break;
          }
        }
        const endMin = chosenEnd
          ? chosenEnd.minutes
          : startMin != null
          ? startMin + 45
          : null;

        const startArr =
          startMin != null
            ? eventTimeFromLessonDateAndMinutes(l.date, startMin)
            : null;
        const endArr =
          endMin != null
            ? eventTimeFromLessonDateAndMinutes(l.date, endMin)
            : null;

        // --- build title, rooms (location) and a description using lstext (no duplicate rooms) ---
        const subject =
          (l.su && l.su[0] && l.su[0].name) ||
          (l.code === "cancelled" ? "CANCELLED" : l.name || "Lesson");

        const teachers = (l.te || [])
          .map((t) => t.name)
          .filter(Boolean)
          .join(", ");

        // rooms (kept only as LOCATION)
        const roomsArr = (l.ro || []).map((r) => r.name).filter(Boolean);
        const rooms = roomsArr.join(", "); // e.g. "NOO.00.025"

        // prefer lstext (type like "practicum", "hoorcollege", etc.)
        const lstext = (l.lstext ?? l.lsText ?? l.lessonType ?? l.type ?? "")
          .toString()
          .trim();

        // build description lines (NO rooms here — rooms are in LOCATION)
        const descrParts = [];
        if (lstext) descrParts.push(lstext); // e.g. "practicum"
        if (l.info) descrParts.push(String(l.info)); // extra info if present
        if (teachers) descrParts.push(`Teachers: ${teachers}`);

        const description = descrParts.join("\n"); // real newlines

        const ev = {
          title: subject,
          description, // real newlines -> will be escaped into \n in the ICS
          location: rooms || undefined,
          uid: `webuntis-${l.id}@${process.env.UNTIS_SERVER ?? "webuntis"}`,
        };
        if (startArr) ev.start = startArr;
        if (endArr) ev.end = endArr;
        return ev;
      });

      let mergedEvents = events;

      function normalizeIdentityForMerge(e) {
        const title = (e.title ?? "").toString().trim().replace(/\s+/g, " ");
        const desc = (e.description ?? "")
          .toString()
          .replace(/\s+/g, " ")
          .trim();
        const uid = (e.uid ?? "").toString().trim();
        return `${title}||${desc}||${uid}`;
      }
      function normalizeTitleForMerge(e) {
        return (e.title ?? "")
          .toString()
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      }
      function startEndToEpochMinutes(arr) {
        if (!arr || arr.length < 5) return null;
        const y = Number(arr[0]),
          m = Number(arr[1]) - 1,
          d = Number(arr[2]),
          h = Number(arr[3]),
          minute = Number(arr[4]);
        if ([y, m, d, h, minute].some((v) => Number.isNaN(v))) return null;
        return Math.floor(Date.UTC(y, m, d, h, minute) / 60000);
      }
      function sortEventsByStart(evts) {
        return evts.slice().sort((A, B) => {
          const a = startEndToEpochMinutes(A.start) ?? 0;
          const b = startEndToEpochMinutes(B.start) ?? 0;
          if (a !== b) return a - b;
          return (A.uid ?? "").localeCompare(B.uid ?? "");
        });
      }

      function mergeWithPredicate(
        evts,
        predicateMergeable,
        toleranceMinutes = 1
      ) {
        if (!Array.isArray(evts) || evts.length <= 1) return evts;
        const sorted = sortEventsByStart(evts);
        const out = [];
        for (const ev of sorted) {
          const evStart = startEndToEpochMinutes(ev.start);
          const evEnd = startEndToEpochMinutes(ev.end);
          if (evStart == null || evEnd == null) {
            out.push({ ...ev });
            continue;
          }
          if (out.length === 0) {
            out.push({ ...ev });
            continue;
          }
          const last = out[out.length - 1];
          const lastEnd = startEndToEpochMinutes(last.end);
          if (lastEnd == null) {
            out.push({ ...ev });
            continue;
          }

          const gap = evStart - lastEnd;

          if (
            gap >= 0 &&
            gap <= toleranceMinutes &&
            predicateMergeable(last, ev)
          ) {
            const laterEnd = Math.max(lastEnd, evEnd);
            const dt = new Date(laterEnd * 60000);
            last.end = [
              dt.getUTCFullYear(),
              dt.getUTCMonth() + 1,
              dt.getUTCDate(),
              dt.getUTCHours(),
              dt.getUTCMinutes(),
            ];
            continue;
          }

          out.push({ ...ev });
        }
        return out;
      }

      // Strict predicate: title+desc+uid exact
      const strictPredicate = (a, b) =>
        normalizeIdentityForMerge(a) === normalizeIdentityForMerge(b);
      // Title-only predicate (looser)
      const titleOnlyPredicate = (a, b) =>
        normalizeTitleForMerge(a) === normalizeTitleForMerge(b);

      // Try strict merge first
      const mergedStrict = mergeWithPredicate(events, strictPredicate, 1);

      if (mergedStrict.length < events.length) {
        console.log(
          "MERGE-DEBUG: strict merged",
          events.length,
          "->",
          mergedStrict.length
        );
        mergedEvents = mergedStrict;
      } else {
        // Try title-only merge
        const mergedTitle = mergeWithPredicate(events, titleOnlyPredicate, 1);
        if (mergedTitle.length < events.length) {
          console.log(
            "MERGE-DEBUG: title-based merged",
            events.length,
            "->",
            mergedTitle.length
          );
          mergedEvents = mergedTitle;
        } else {
          // Nothing merged — print pairwise reasons to diagnose
          console.log(
            "MERGE-DEBUG: no merges performed (strict nor title-based). Printing pair diagnostics..."
          );
          const sorted = sortEventsByStart(events);
          for (let i = 0; i < Math.max(0, sorted.length - 1); i++) {
            const a = sorted[i],
              b = sorted[i + 1];
            const ai = normalizeIdentityForMerge(a);
            const bi = normalizeIdentityForMerge(b);
            const at = normalizeTitleForMerge(a);
            const bt = normalizeTitleForMerge(b);
            const aStart = startEndToEpochMinutes(a.start);
            const aEnd = startEndToEpochMinutes(a.end);
            const bStart = startEndToEpochMinutes(b.start);
            const bEnd = startEndToEpochMinutes(b.end);
            console.log("MERGE-PAIR-DEBUG", {
              idx: i,
              titleA: a.title,
              titleB: b.title,
              uidA: a.uid,
              uidB: b.uid,
              identityEqual: ai === bi,
              titleEqual: at === bt,
              startA: a.start,
              endA: a.end,
              startB: b.start,
              endB: b.end,
              gapMinutes: bStart == null || aEnd == null ? null : bStart - aEnd,
            });
          }
          mergedEvents = events; // fallback -> no change
        }
      }

      console.log(
        "MERGE-DEBUG: events before=",
        events.length,
        "after=",
        mergedEvents.length
      );
      // ---------- Emit UTC timestamps (single conversion) ----------
      console.log(
        "MERGE-DEBUG: events before=",
        events.length,
        "after=",
        mergedEvents.length
      );

      const pad = (n, len = 2) => String(n).padStart(len, "0");
      function icsEscape(text = "") {
        return String(text)
          .replace(/\\/g, "\\\\")
          .replace(/\r\n/g, "\\n")
          .replace(/\n/g, "\\n")
          .replace(/;/g, "\\;")
          .replace(/,/g, "\\,");
      }
      function formatUtc(dt) {
        return dt.toFormat("yyyyLLdd'T'HHmmss'Z'");
      }

      let ics = "";
      ics += "BEGIN:VCALENDAR\r\n";
      ics += "PRODID:-//your-org//untis-ics//EN\r\n";
      ics += "VERSION:2.0\r\n";
      ics += "CALSCALE:GREGORIAN\r\n";
      ics += "METHOD:PUBLISH\r\n";

      const nowUtc = DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'");

      for (const ev of mergedEvents) {
        if (!ev.start || !ev.end) continue;

        const startLocal = DateTime.fromObject(
          {
            year: ev.start[0],
            month: ev.start[1],
            day: ev.start[2],
            hour: ev.start[3],
            minute: ev.start[4],
          },
          { zone: "Europe/Brussels" }
        );
        const endLocal = DateTime.fromObject(
          {
            year: ev.end[0],
            month: ev.end[1],
            day: ev.end[2],
            hour: ev.end[3],
            minute: ev.end[4],
          },
          { zone: "Europe/Brussels" }
        );

        const startUtc = startLocal.toUTC();
        const endUtc = endLocal.toUTC();

        if (!startUtc.isValid || !endUtc.isValid) continue;

        ics += "BEGIN:VEVENT\r\n";
        const uid =
          ev.uid ||
          `untis-${Math.random().toString(36).slice(2)}@${
            process.env.UNTIS_SERVER ?? "untis"
          }`;
        ics += `UID:${icsEscape(uid)}\r\n`;
        ics += `DTSTAMP:${nowUtc}\r\n`;
        ics += `DTSTART:${formatUtc(startUtc)}\r\n`;
        ics += `DTEND:${formatUtc(endUtc)}\r\n`;
        if (ev.location) ics += `LOCATION:${icsEscape(ev.location)}\r\n`;
        ics += `SUMMARY:${icsEscape(ev.title || "Lesson")}\r\n`;
        if (ev.description)
          ics += `DESCRIPTION:${icsEscape(ev.description)}\r\n`;
        ics += "END:VEVENT\r\n";
      }

      ics += "END:VCALENDAR\r\n";

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="class-${classId}.ics"`
      );
      res.send(ics);
    } catch (err) {
      try {
        await untis.logout();
      } catch (e) {}
      return res.status(500).send(err?.message || String(err));
    }
  } catch (err) {
    console.error("Error /ics/class", err);
    return res.status(500).send(err?.message || String(err));
  } finally {
    try {
      await untis.logout();
    } catch (e) {
      /* ignore */
    }
  }
});

// GET /ics/class/:id
// Generates an ICS for the full school year containing the specified class ID,
// with optional subject filtering via ?excludeSubjects=11,22
app.get("/ics/class/:id", async (req, res) => {
  const classId = Number(req.params.id);
  if (Number.isNaN(classId)) return res.status(400).send("id must be numeric");

  const untis = makeUntisInstance();
  try {
    await untis.login();

    // find schoolyear
    let sy = await findSchoolyearContainingClass(untis, classId);
    if (!sy) {
      const d = new Date();
      const todayIso = d.toISOString().slice(0, 10);
      sy = await findSchoolyearForDate(untis, todayIso);
    }
    if (!sy) {
      await untis.logout();
      return res
        .status(404)
        .send(`Could not determine schoolyear for class ${classId}`);
    }

    // robust formatter: returns "YYYY-MM-DD" for many input shapes
    function formatYMD(v) {
      if (v == null) return null;
      if (v instanceof Date) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, "0");
        const d = String(v.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
      if (typeof v === "number") v = String(v);
      if (typeof v === "string") {
        v = v.trim();
        if (/^\d{8}$/.test(v))
          return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
        if (m) return m[1];
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) {
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
            2,
            "0"
          )}-${String(d.getDate()).padStart(2, "0")}`;
        }
      }
      return null;
    }

    const startIso = formatYMD(sy.startDate);
    const endIso = formatYMD(sy.endDate);
    if (!startIso || !endIso) {
      await untis.logout();
      return res.status(500).send("Bad schoolyear date format from Untis");
    }

    const ELEMENT_TYPE_CLASS = 1;
    const s = parseDateISO(startIso);
    const e = parseDateISO(endIso);

    const lessonsRaw = await untis.getTimetableForRange(
      s,
      e,
      classId,
      ELEMENT_TYPE_CLASS
    );

    // exclusions
    const excludeRaw = (
      req.query.excludeSubjects ||
      req.query.exclude ||
      ""
    ).toString();
    const excludeSet = new Set(
      excludeRaw
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => !Number.isNaN(n))
    );
    let lessons = lessonsRaw;
    if (excludeSet.size > 0) {
      lessons = lessons.filter((l) => {
        const sid = l.su?.[0]?.id ? Number(l.su[0].id) : null;
        return sid == null ? true : !excludeSet.has(sid);
      });
    }

    // events
    let events = lessons.map((l) => {
      const subject =
        l.su?.[0]?.name ||
        (l.code === "cancelled" ? "CANCELLED" : l.name || "Lesson");
      const teachers = (l.te || [])
        .map((t) => t.name)
        .filter(Boolean)
        .join(", ");
      const roomsArr = (l.ro || []).map((r) => r.name).filter(Boolean);
      const rooms = roomsArr.join(", ");
      const lstext = (l.lstext ?? l.lsText ?? "").toString().trim();

      const descrParts = [];
      if (lstext) descrParts.push(lstext);
      if (l.info) descrParts.push(String(l.info));
      if (teachers) descrParts.push(`Teachers: ${teachers}`);
      const description = descrParts.join("\n");

      const startMin = normalizeLessonTime(l.startTime, "start").minutes;
      const endMin = normalizeLessonTime(l.endTime, "end").minutes;
      const startArr =
        startMin != null
          ? eventTimeFromLessonDateAndMinutes(l.date, startMin)
          : null;
      const endArr =
        endMin != null
          ? eventTimeFromLessonDateAndMinutes(l.date, endMin)
          : null;

      return {
        title: subject,
        description,
        location: rooms || undefined,
        uid: `webuntis-${l.id}@${process.env.UNTIS_SERVER ?? "webuntis"}`,
        start: startArr,
        end: endArr,
      };
    });

    // ---------- robust merge: merge overlapping/adjacent identical events ----------
    const MERGE_TOLERANCE_MIN = 1; // merge when gap <= 1 minute
    const MERGE_DEBUG = process.env.MERGE_DEBUG === "1";

    // normalize identity used for merging
    function normalizeIdentity(e) {
      const title = (e.title ?? "").toString().trim().replace(/\s+/g, " ");
      const desc = (e.description ?? "").toString().trim().replace(/\s+/g, " ");
      const loc = (e.location ?? "").toString().trim().replace(/\s+/g, " ");
      return `${title}||${desc}||${loc}`;
    }

    // epoch minutes computed from local Europe/Brussels wall-clock
    function epochMinutesFromLocalArray(arr) {
      if (!arr || arr.length < 5) return null;
      const dt = DateTime.fromObject(
        {
          year: Number(arr[0]),
          month: Number(arr[1]),
          day: Number(arr[2]),
          hour: Number(arr[3]),
          minute: Number(arr[4]),
        },
        { zone: "Europe/Brussels" }
      );
      if (!dt.isValid) return null;
      return Math.floor(dt.toUTC().toMillis() / 60000); // epoch minutes UTC
    }

    // convert epoch minutes back into local [Y,M,D,H,MM] in Europe/Brussels
    function localArrayFromEpochMinutes(epochMin) {
      const dt = DateTime.fromMillis(epochMin * 60000, { zone: "UTC" }).setZone(
        "Europe/Brussels"
      );
      return [dt.year, dt.month, dt.day, dt.hour, dt.minute];
    }

    // sort events by start epoch (stable)
    events = (events || []).slice().map((e) => ({ ...e })); // shallow copy
    events.sort((A, B) => {
      const a = epochMinutesFromLocalArray(A.start) ?? 0;
      const b = epochMinutesFromLocalArray(B.start) ?? 0;
      if (a !== b) return a - b;
      return normalizeIdentity(A).localeCompare(normalizeIdentity(B));
    });

    // merging pass: merge overlapping/adjacent events with identical identity
    const mergedEvents = [];
    for (const ev of events) {
      const evStart = epochMinutesFromLocalArray(ev.start);
      const evEnd = epochMinutesFromLocalArray(ev.end);
      if (evStart == null || evEnd == null) {
        // can't reason about times -> push as-is
        mergedEvents.push({ ...ev });
        continue;
      }

      if (mergedEvents.length === 0) {
        mergedEvents.push({ ...ev });
        continue;
      }

      const last = mergedEvents[mergedEvents.length - 1];
      const lastStart = epochMinutesFromLocalArray(last.start);
      const lastEnd = epochMinutesFromLocalArray(last.end);
      if (lastStart == null || lastEnd == null) {
        mergedEvents.push({ ...ev });
        continue;
      }

      const sameIdentity = normalizeIdentity(last) === normalizeIdentity(ev);
      const gap = evStart - lastEnd; // minutes (can be negative if overlap)

      if (sameIdentity && gap <= MERGE_TOLERANCE_MIN) {
        // merge: extend last.end to max(lastEnd, evEnd)
        const newEnd = Math.max(lastEnd, evEnd);
        last.end = localArrayFromEpochMinutes(newEnd);
        if (MERGE_DEBUG) {
          console.log("MERGE: merged", {
            title: last.title,
            mergedGap: gap,
            newEnd,
          });
        }
      } else {
        // no merge -> push as separate event
        if (MERGE_DEBUG) {
          console.log("MERGE: no-merge", {
            titleLast: last.title,
            titleCur: ev.title,
            identityEqual: sameIdentity,
            gap,
          });
        }
        mergedEvents.push({ ...ev });
      }
    }

    console.log(
      `MERGE-DEBUG: events before=${events.length} after=${mergedEvents.length}`
    );

    // ---------- Build ICS with UTC timestamps ----------
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    function icsEscape(text = "") {
      return String(text)
        .replace(/\\/g, "\\\\")
        .replace(/\r\n/g, "\\n")
        .replace(/\n/g, "\\n")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,");
    }
    function formatUtc(dt) {
      return dt.toFormat("yyyyLLdd'T'HHmmss'Z'");
    }

    let ics = "";
    ics += "BEGIN:VCALENDAR\r\n";
    ics += "PRODID:-//your-org//untis-ics//EN\r\n";
    ics += "VERSION:2.0\r\n";
    ics += "CALSCALE:GREGORIAN\r\n";
    ics += "METHOD:PUBLISH\r\n";

    const nowUtc = DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'");

    for (const ev of mergedEvents) {
      if (!ev.start || !ev.end) continue;

      // convert local Europe/Brussels array -> Luxon (zone-aware) -> to UTC instant
      const startLocal = DateTime.fromObject(
        {
          year: ev.start[0],
          month: ev.start[1],
          day: ev.start[2],
          hour: ev.start[3],
          minute: ev.start[4],
        },
        { zone: "Europe/Brussels" }
      );
      const endLocal = DateTime.fromObject(
        {
          year: ev.end[0],
          month: ev.end[1],
          day: ev.end[2],
          hour: ev.end[3],
          minute: ev.end[4],
        },
        { zone: "Europe/Brussels" }
      );

      const startUtc = startLocal.toUTC();
      const endUtc = endLocal.toUTC();

      if (!startUtc.isValid || !endUtc.isValid) continue;

      const uid =
        ev.uid ||
        `untis-${Math.random().toString(36).slice(2)}@${
          process.env.UNTIS_SERVER ?? "untis"
        }`;

      ics += "BEGIN:VEVENT\r\n";
      ics += `UID:${icsEscape(uid)}\r\n`;
      ics += `DTSTAMP:${nowUtc}\r\n`;
      ics += `DTSTART:${formatUtc(startUtc)}\r\n`;
      ics += `DTEND:${formatUtc(endUtc)}\r\n`;
      if (ev.location) ics += `LOCATION:${icsEscape(ev.location)}\r\n`;
      ics += `SUMMARY:${icsEscape(ev.title || "Lesson")}\r\n`;
      if (ev.description) ics += `DESCRIPTION:${icsEscape(ev.description)}\r\n`;
      ics += "END:VEVENT\r\n";
    }

    ics += "END:VCALENDAR\r\n";

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="class-${classId}.ics"`
    );
    res.send(ics);
  } catch (err) {
    console.error("/ics/class/:id error", err);
    res.status(500).send(err?.message || String(err));
  } finally {
    try {
      await untis.logout();
    } catch {}
  }
});

// GET /schoolyears
// Returns list of available school years
app.get("/schoolyears", async (req, res) => {
  const untis = makeUntisInstance();
  try {
    await untis.login();
    const years = await untis.getSchoolyears();
    await untis.logout();
    res.json(years);
  } catch (err) {
    try {
      await untis.logout();
    } catch (e) {}
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// GET /debug/lessons?id=41213&start=2025-09-15&end=2025-09-27&type=1
app.get("/debug/lessons", async (req, res) => {
  const { id, start, end, type } = req.query;
  if (!id || !start || !end)
    return res.status(400).send("Provide id,start,end (YYYY-MM-DD)");
  const classId = Number(id);
  const elementType = type ? Number(type) : 1;
  try {
    const untis = makeUntisInstance();
    await untis.login();
    const lessons = await untis.getTimetableForRange(
      parseDateISO(start),
      parseDateISO(end),
      classId,
      elementType
    );
    await untis.logout();
    // return full JSON (pretty)
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(JSON.stringify(lessons, null, 2));
  } catch (err) {
    try {
      await untis.logout();
    } catch (e) {}
    console.error("DEBUG /debug/lessons error", err);
    return res.status(500).send(err?.message || String(err));
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
