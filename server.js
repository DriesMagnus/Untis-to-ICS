// server.js (ESM) — cleaned & refactored
import express from "express";
import { WebUntis } from "webuntis";
import { DateTime } from "luxon";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const UNTIS_ZONE = "Europe/Brussels";

function makeUntisInstance() {
  return new WebUntis(
    process.env.UNTIS_SCHOOL,
    process.env.UNTIS_USERNAME,
    process.env.UNTIS_PASSWORD,
    process.env.UNTIS_SERVER
  );
}

function parseDateISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Bad date: ${iso}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

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
    if (!Number.isNaN(d.getTime())) return formatYMD(d);
  }
  return null;
}

function toUntisYMD(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return y * 10000 + m * 100 + d;
}

async function findSchoolyearForDate(untis, dateIso) {
  const ymd = toUntisYMD(dateIso);
  const years = await untis.getSchoolyears();
  return (
    years.find((y) => {
      const start = Number(y.startDate);
      const end = Number(y.endDate);
      return start <= ymd && ymd <= end;
    }) || null
  );
}

async function findSchoolyearContainingClass(untis, classId) {
  const years = await untis.getSchoolyears();
  for (const y of years) {
    try {
      const classes = await untis.getClasses(undefined, y.id);
      if (
        Array.isArray(classes) &&
        classes.some((c) => Number(c.id) === Number(classId))
      )
        return y;
    } catch (err) {
      console.warn(
        `Warning: getClasses failed for schoolyear ${y.id}:`,
        err?.message ?? err
      );
    }
  }
  return null;
}

function subjectDisplayNameFromLesson(l) {
  const su = l?.su?.[0];
  if (!su) return null;
  return su.longname ?? su.longName ?? su.name ?? null;
}
function teacherDisplayName(t) {
  if (!t) return "";
  return (t.longname ?? t.longName ?? t.name ?? "").toString().trim();
}
function formatLstext(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  const first = s[0];
  if (first.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/))
    return "Info: " + first.toUpperCase() + s.slice(1);
  return "Info: " + s;
}

function normalizeLessonTime(raw) {
  if (raw == null) return { minutes: null };
  if (typeof raw === "string" && raw.includes(":")) {
    const parts = raw.split(":").map(Number);
    if (parts.length >= 2 && !parts.some(Number.isNaN))
      return { minutes: parts[0] * 60 + parts[1] };
  }
  const v = Number(raw);
  if (Number.isNaN(v)) return { minutes: null };
  if (v >= 100 && v <= 235959) {
    const s = String(Math.floor(v));
    if (s.length <= 4) {
      const hh = Number(s.padStart(4, "0").slice(0, 2));
      const mm = Number(s.padStart(4, "0").slice(2, 4));
      if (hh < 24 && mm < 60) return { minutes: hh * 60 + mm };
    } else {
      const hh = Number(s.padStart(6, "0").slice(0, 2));
      const mm = Number(s.padStart(6, "0").slice(2, 4));
      if (hh < 24 && mm < 60) return { minutes: hh * 60 + mm };
    }
  }
  if (v >= 0 && v <= 1440) return { minutes: Math.floor(v) };
  if (v <= 86400) return { minutes: Math.floor(v / 60) };
  return { minutes: Math.floor(v / 60000) };
}

function eventTimeFromLessonDateAndMinutes(dateValue, minutes) {
  if (minutes == null) return null;
  let y, m, d;
  if (typeof dateValue === "string" && /^\d{8}$/.test(dateValue)) {
    y = Number(dateValue.slice(0, 4));
    m = Number(dateValue.slice(4, 6));
    d = Number(dateValue.slice(6, 8));
  } else if (typeof dateValue === "number" && String(dateValue).length === 8) {
    const s = String(dateValue);
    y = Number(s.slice(0, 4));
    m = Number(s.slice(4, 6));
    d = Number(s.slice(6, 8));
  } else if (dateValue instanceof Date) {
    y = dateValue.getFullYear();
    m = dateValue.getMonth() + 1;
    d = dateValue.getDate();
  } else {
    const dt = new Date();
    y = dt.getFullYear();
    m = dt.getMonth() + 1;
    d = dt.getDate();
  }
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return [y, m, d, h, mm];
}

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
    { zone: UNTIS_ZONE }
  );
  if (!dt.isValid) return null;
  return Math.floor(dt.toUTC().toMillis() / 60000);
}
function localArrayFromEpochMinutes(epochMin) {
  const dt = DateTime.fromMillis(epochMin * 60000, { zone: "UTC" }).setZone(
    UNTIS_ZONE
  );
  return [dt.year, dt.month, dt.day, dt.hour, dt.minute];
}

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
function uidFromEvent(ev, classId, req) {
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const s = ev.start
    ? `${ev.start[0]}${pad(ev.start[1])}${pad(ev.start[2])}T${pad(
        ev.start[3]
      )}${pad(ev.start[4])}`
    : "nostart";
  const e = ev.end
    ? `${ev.end[0]}${pad(ev.end[1])}${pad(ev.end[2])}T${pad(ev.end[3])}${pad(
        ev.end[4]
      )}`
    : "noend";
  const host = (process.env.UNTIS_SERVER || req.get("host") || "untis")
    .toString()
    .replace(/\s+/g, "");
  return `class${classId}-${s}-${e}@${host}`;
}

function buildEventsFromLessons(lessons) {
  return (lessons || []).map((l) => {
    const subject =
      subjectDisplayNameFromLesson(l) ||
      (l.code === "cancelled" ? "CANCELLED" : l.name || "Lesson");
    const teachers = (l.te || [])
      .map(teacherDisplayName)
      .filter(Boolean)
      .join(", ");
    const rooms = (l.ro || [])
      .map((r) => r.name)
      .filter(Boolean)
      .join(", ");
    const rawLstext = l.lstext ?? l.lsText ?? l.lessonType ?? l.type ?? "";
    const lstext = formatLstext(rawLstext);

    const descrParts = [];
    if (lstext) descrParts.push(lstext);
    if (l.info) descrParts.push(String(l.info));
    if (teachers) descrParts.push(`Teachers: ${teachers}`);
    const description = descrParts.join("\n");

    const startMin = normalizeLessonTime(l.startTime ?? l.start).minutes;
    const endMin = normalizeLessonTime(l.endTime ?? l.end).minutes;
    const start =
      startMin != null
        ? eventTimeFromLessonDateAndMinutes(l.date, startMin)
        : null;
    const end =
      endMin != null ? eventTimeFromLessonDateAndMinutes(l.date, endMin) : null;

    return {
      title: subject,
      description,
      location: rooms || undefined,
      uid: `webuntis-${l.id}@${process.env.UNTIS_SERVER ?? "webuntis"}`,
      start,
      end,
    };
  });
}

function mergeEvents(events, toleranceMinutes = 1) {
  const MERGE_DEBUG = process.env.MERGE_DEBUG === "1";
  events = (events || []).slice().map((e) => ({ ...e }));
  events.sort((A, B) => {
    const a = epochMinutesFromLocalArray(A.start) ?? 0;
    const b = epochMinutesFromLocalArray(B.start) ?? 0;
    if (a !== b) return a - b;
    return (
      (A.title ?? "") +
      (A.description ?? "") +
      (A.location ?? "")
    ).localeCompare(
      (B.title ?? "") + (B.description ?? "") + (B.location ?? "")
    );
  });

  const out = [];
  for (const ev of events) {
    const evStart = epochMinutesFromLocalArray(ev.start);
    const evEnd = epochMinutesFromLocalArray(ev.end);
    if (evStart == null || evEnd == null) {
      out.push({ ...ev });
      continue;
    }
    if (out.length === 0) {
      out.push({ ...ev });
      continue;
    }

    const last = out[out.length - 1];
    const lastEnd = epochMinutesFromLocalArray(last.end);
    if (lastEnd == null) {
      out.push({ ...ev });
      continue;
    }

    const sameIdentity =
      (last.title ?? "").trim() === (ev.title ?? "").trim() &&
      (last.description ?? "").trim() === (ev.description ?? "").trim() &&
      (last.location ?? "").trim() === (ev.location ?? "").trim();

    const gap = evStart - lastEnd;
    if (sameIdentity && gap <= toleranceMinutes) {
      const newEnd = Math.max(lastEnd, evEnd);
      last.end = localArrayFromEpochMinutes(newEnd);
      if (MERGE_DEBUG)
        console.log("MERGE: merged", { title: last.title, gap, newEnd });
    } else {
      if (MERGE_DEBUG)
        console.log("MERGE: no-merge", {
          titleLast: last.title,
          titleCur: ev.title,
          sameIdentity,
          gap,
        });
      out.push({ ...ev });
    }
  }
  if (process.env.MERGE_DEBUG === "1")
    console.log(`MERGE-DEBUG: before=${events.length} after=${out.length}`);
  return out;
}

function buildIcs(mergedEvents, classId, req) {
  const nowUtc = DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'");
  let ics = "";
  ics +=
    "BEGIN:VCALENDAR\r\nPRODID:-//your-org//untis-ics//EN\r\nVERSION:2.0\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n";

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
      { zone: UNTIS_ZONE }
    ).toUTC();
    const endLocal = DateTime.fromObject(
      {
        year: ev.end[0],
        month: ev.end[1],
        day: ev.end[2],
        hour: ev.end[3],
        minute: ev.end[4],
      },
      { zone: UNTIS_ZONE }
    ).toUTC();
    if (!startLocal.isValid || !endLocal.isValid) continue;

    const uid = uidFromEvent(ev, classId, req);
    ics += "BEGIN:VEVENT\r\n";
    ics += `UID:${icsEscape(uid)}\r\n`;
    ics += `DTSTAMP:${nowUtc}\r\n`;
    ics += `DTSTART:${formatUtc(startLocal)}\r\n`;
    ics += `DTEND:${formatUtc(endLocal)}\r\n`;
    if (ev.location) ics += `LOCATION:${icsEscape(ev.location)}\r\n`;
    ics += `SUMMARY:${icsEscape(ev.title || "Lesson")}\r\n`;
    if (ev.description) ics += `DESCRIPTION:${icsEscape(ev.description)}\r\n`;
    ics += "END:VEVENT\r\n";
  }

  ics += "END:VCALENDAR\r\n";
  return ics;
}

async function determineRangeForClass(
  untis,
  classId,
  providedStart,
  providedEnd,
  providedSchoolyear
) {
  let startIso = providedStart,
    endIso = providedEnd,
    syId = providedSchoolyear ? Number(providedSchoolyear) : undefined;

  if (!startIso || !endIso) {
    let sy = undefined;
    if (syId) {
      const years = await untis.getSchoolyears();
      sy = years.find((y) => Number(y.id) === syId);
    }
    if (!sy) sy = await findSchoolyearContainingClass(untis, classId);
    if (!sy) {
      const d = new Date();
      sy = await findSchoolyearForDate(
        untis,
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(d.getDate()).padStart(2, "0")}`
      );
    }
    if (!sy) throw new Error("Could not determine schoolyear for the class");
    syId = sy.id;
    startIso = startIso || formatYMD(sy.startDate);
    endIso = endIso || formatYMD(sy.endDate);
  }

  const s = parseDateISO(startIso);
  const e = parseDateISO(endIso);
  return { s, e, syId, startIso, endIso };
}

/* Routes */

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
    const classes = await untis.getClasses(undefined, syId);
    await untis.logout();
    res.json({ schoolyear: syId ?? null, classes });
  } catch (err) {
    try {
      await untis.logout();
    } catch {}
    res.status(500).json({ error: err?.message || String(err) });
  }
});

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
    } catch {}
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get("/debug/lessons", async (req, res) => {
  const { id, start, end, type } = req.query;
  if (!id || !start || !end)
    return res.status(400).send("Provide id,start,end (YYYY-MM-DD)");
  const classId = Number(id),
    elementType = type ? Number(type) : 1;
  const untis = makeUntisInstance();
  try {
    await untis.login();
    const lessons = await untis.getTimetableForRange(
      parseDateISO(start),
      parseDateISO(end),
      classId,
      elementType
    );
    await untis.logout();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(lessons, null, 2));
  } catch (err) {
    try {
      await untis.logout();
    } catch {}
    console.error("DEBUG /debug/lessons error", err);
    res.status(500).send(err?.message || String(err));
  }
});

// /ics/class?id=...&start=...&end=...  (range required unless omitted and auto-detected)
app.get("/ics/class", async (req, res) => {
  const { id, start, end, schoolyear } = req.query;
  if (!id || !start || !end)
    return res.status(400).send("Missing id,start,end");
  const classId = Number(id);
  if (Number.isNaN(classId)) return res.status(400).send("id must be numeric");

  const untis = makeUntisInstance();
  try {
    await untis.login();
    const s = parseDateISO(start),
      e = parseDateISO(end);
    let lessons = await untis.getTimetableForRange(s, e, classId, 1);

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
    if (excludeSet.size) {
      lessons = (lessons || []).filter((l) => {
        const sid = l?.su?.[0]?.id ? Number(l.su[0].id) : null;
        return sid == null ? true : !excludeSet.has(sid);
      });
    }

    await untis.logout();

    const events = buildEventsFromLessons(lessons);
    const merged = mergeEvents(events);
    const ics = buildIcs(merged, classId, req);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="class-${classId}.ics"`
    );
    res.send(ics);
  } catch (err) {
    try {
      await untis.logout();
    } catch {}
    console.error("Error /ics/class", err);
    res.status(500).send(err?.message || String(err));
  }
});

// /ics/class/:id  -> full schoolyear for class (exclude via ?exclude=...)
app.get("/ics/class/:id", async (req, res) => {
  const classId = Number(req.params.id);
  if (Number.isNaN(classId)) return res.status(400).send("id must be numeric");
  const untis = makeUntisInstance();
  try {
    await untis.login();
    const { s, e } = await determineRangeForClass(
      untis,
      classId,
      req.query.start,
      req.query.end,
      req.query.schoolyear
    );
    let lessons = await untis.getTimetableForRange(s, e, classId, 1);

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
    if (excludeSet.size) {
      lessons = (lessons || []).filter((l) => {
        const sid = l?.su?.[0]?.id ? Number(l.su[0].id) : null;
        return sid == null ? true : !excludeSet.has(sid);
      });
    }

    await untis.logout();

    const events = buildEventsFromLessons(lessons);
    const merged = mergeEvents(events);
    const ics = buildIcs(merged, classId, req);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="class-${classId}.ics"`
    );
    res.send(ics);
  } catch (err) {
    try {
      await untis.logout();
    } catch {}
    console.error("/ics/class/:id error", err);
    res.status(500).send(err?.message || String(err));
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
