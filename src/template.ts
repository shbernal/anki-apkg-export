export interface TemplateOptions {
  questionFormat?: string;
  answerFormat?: string;
  css?: string;
}

/*
 * The four objects below are Anki's own collection defaults. They are
 * JSON.stringify'd into the generated collection.anki2 verbatim, so their keys
 * and key order are emitted output rather than formatting.
 */

const CONF = {
  nextPos: 1,
  estTimes: true,
  activeDecks: [1],
  sortType: "noteFld",
  timeLim: 0,
  sortBackwards: false,
  addToCur: true,
  curDeck: 1,
  newBury: true,
  newSpread: 0,
  dueCounts: true,
  curModel: "1435645724216",
  collapseTime: 1200,
};

const NOTE_FIELDS = [
  {
    name: "Front",
    media: [],
    sticky: false,
    rtl: false,
    ord: 0,
    font: "Arial",
    size: 20,
  },
  {
    name: "Back",
    media: [],
    sticky: false,
    rtl: false,
    ord: 1,
    font: "Arial",
    size: 20,
  },
];

const LATEX_PRE =
  "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n";

const DECKS = {
  1: {
    desc: "",
    name: "Default",
    extendRev: 50,
    usn: 0,
    collapsed: false,
    newToday: [0, 0],
    timeToday: [0, 0],
    dyn: 0,
    extendNew: 10,
    conf: 1,
    revToday: [0, 0],
    lrnToday: [0, 0],
    id: 1,
    mod: 1_435_645_724,
  },
  1_435_588_830_424: {
    desc: "",
    name: "Template",
    extendRev: 50,
    usn: -1,
    collapsed: false,
    newToday: [545, 0],
    timeToday: [545, 0],
    dyn: 0,
    extendNew: 10,
    conf: 1,
    revToday: [545, 0],
    lrnToday: [545, 0],
    id: 1_435_588_830_424,
    mod: 1_435_588_830,
  },
};

const DCONF = {
  1: {
    name: "Default",
    replayq: true,
    lapse: {
      leechFails: 8,
      minInt: 1,
      delays: [10],
      leechAction: 0,
      mult: 0,
    },
    rev: {
      perDay: 100,
      fuzz: 0.05,
      ivlFct: 1,
      maxIvl: 36_500,
      ease4: 1.3,
      bury: true,
      minSpace: 1,
    },
    timer: 0,
    maxTaken: 60,
    usn: 0,
    new: {
      perDay: 20,
      delays: [1, 10],
      separate: true,
      ints: [1, 4, 7],
      initialFactor: 2500,
      bury: true,
      order: 1,
    },
    mod: 0,
    id: 1,
    autoplay: true,
  },
};

/** The note model is the only default that varies with the caller's overrides. */
const buildModels = ({ questionFormat, answerFormat, css }: Required<TemplateOptions>) => ({
  1_388_596_687_391: {
    veArs: [],
    name: "Basic-f15d2",
    tags: ["Tag"],
    did: 1_435_588_830_424,
    usn: -1,
    req: [[0, "all", [0]]],
    flds: NOTE_FIELDS,
    sortf: 0,
    latexPre: LATEX_PRE,
    tmpls: [
      {
        name: "Card 1",
        qfmt: questionFormat,
        did: null,
        bafmt: "",
        afmt: answerFormat,
        ord: 0,
        bqfmt: "",
      },
    ],
    latexPost: "\\end{document}",
    type: 0,
    id: 1_388_596_687_391,
    css,
    mod: 1_435_645_658,
  },
});

const COL_TABLE = `
    CREATE TABLE col (
        id              integer primary key,
        crt             integer not null,
        mod             integer not null,
        scm             integer not null,
        ver             integer not null,
        dty             integer not null,
        usn             integer not null,
        ls              integer not null,
        conf            text not null,
        models          text not null,
        decks           text not null,
        dconf           text not null,
        tags            text not null
    );`;

const NOTE_TABLES = `
    CREATE TABLE notes (
        id              integer primary key,   /* 0 */
        guid            text not null,         /* 1 */
        mid             integer not null,      /* 2 */
        mod             integer not null,      /* 3 */
        usn             integer not null,      /* 4 */
        tags            text not null,         /* 5 */
        flds            text not null,         /* 6 */
        sfld            integer not null,      /* 7 */
        csum            integer not null,      /* 8 */
        flags           integer not null,      /* 9 */
        data            text not null          /* 10 */
    );
    CREATE TABLE cards (
        id              integer primary key,   /* 0 */
        nid             integer not null,      /* 1 */
        did             integer not null,      /* 2 */
        ord             integer not null,      /* 3 */
        mod             integer not null,      /* 4 */
        usn             integer not null,      /* 5 */
        type            integer not null,      /* 6 */
        queue           integer not null,      /* 7 */
        due             integer not null,      /* 8 */
        ivl             integer not null,      /* 9 */
        factor          integer not null,      /* 10 */
        reps            integer not null,      /* 11 */
        lapses          integer not null,      /* 12 */
        left            integer not null,      /* 13 */
        odue            integer not null,      /* 14 */
        odid            integer not null,      /* 15 */
        flags           integer not null,      /* 16 */
        data            text not null          /* 17 */
    );
    CREATE TABLE revlog (
        id              integer primary key,
        cid             integer not null,
        usn             integer not null,
        ease            integer not null,
        ivl             integer not null,
        lastIvl         integer not null,
        factor          integer not null,
        time            integer not null,
        type            integer not null
    );
    CREATE TABLE graves (
        usn             integer not null,
        oid             integer not null,
        type            integer not null
    );`;

const INDEXES = `
    ANALYZE sqlite_master;
    INSERT INTO "sqlite_stat1" VALUES('col',NULL,'1');
    CREATE INDEX ix_notes_usn on notes (usn);
    CREATE INDEX ix_cards_usn on cards (usn);
    CREATE INDEX ix_revlog_usn on revlog (usn);
    CREATE INDEX ix_cards_nid on cards (nid);
    CREATE INDEX ix_cards_sched on cards (did, queue, due);
    CREATE INDEX ix_revlog_cid on revlog (cid);
    CREATE INDEX ix_notes_csum on notes (csum);`;

export default function createTemplate({
  questionFormat = "{{Front}}",
  answerFormat = '{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}',
  css = ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\nbackground-color: white;\n}\n",
}: Readonly<TemplateOptions> = {}): string {
  const models = buildModels({ questionFormat, answerFormat, css });

  return `
    PRAGMA foreign_keys=OFF;
    BEGIN TRANSACTION;${COL_TABLE}
    INSERT INTO "col" VALUES(
      1,
      1388548800,
      1435645724219,
      1435645724215,
      11,
      0,
      0,
      0,
      '${JSON.stringify(CONF)}',
      '${JSON.stringify(models)}',
      '${JSON.stringify(DECKS)}',
      '${JSON.stringify(DCONF)}',
      '{}'
    );${NOTE_TABLES}${INDEXES}
    COMMIT;
  `;
}
