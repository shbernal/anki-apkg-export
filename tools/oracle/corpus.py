"""The corpus of field values the oracle feeds to real Anki.

Each string here is written into the first field of a note in a genuine
collection; `gen_stripped_fields.py` reads back the `sfld` and `csum` Anki
computed and commits them as the fixture `src/text.ts` is asserted against.

Adding a case is cheap and always safe: regenerate the fixture in the same
commit and the new expectation comes from Anki rather than from us. Removing a
case is not -- it silently drops coverage -- so prefer to leave cases in place.
"""

from named_entities import NAMED_ENTITIES

# Cases written by hand, grouped by the behaviour of `strip_html` they pin down.
LITERAL_CASES: list[str] = [
    # plain
    "test",
    "今日",
    "",
    "   ",
    "plain text here",
    # media tags, all three quoting styles
    '<img src="probe.txt" />',
    'with media <img src="probe.txt" />',
    "<img src='foo.jpg'><html>",
    "<img src=foo.jpg>",
    "<img src=foo.jpg >",
    '<img src="a.png"><img src="b.png">',
    '<audio src="s.mp3"></audio>',
    '<object data="o.swf">',
    '<source src="v.webm">',
    '<img alt="x" src="c.png" title="y">',
    '<img src="sp ace.png">',
    # sound tags
    "[sound:x.mp3]",
    "before [sound:x.mp3] after",
    # entities
    "&amp;",
    "&nbsp;",
    "&lt;b&gt;",
    "&#65;",
    "&#x41;",
    "a & b",
    "&amp; & foo",
    "&notarealentity;",
    "Tom &amp; Jerry",
    "&amp;amp;",
    # comments / style / script
    "<!-- comment -->",
    "a<!-- c -->b",
    "so<SCRIPT>t<b>e</b>st</script>me",
    "<style>p{color:red}</style>text",
    # nesting / structure
    "t<b>e</b>st",
    "<b>a<i>b</i></b>",
    "<div>one</div><div>two</div>",
    "line<br>break",
    "<html>",
    # newlines and whitespace
    "a\nb",
    "  leading and trailing  ",
    # combinations
    'q &amp; a <img src="z.png"> [sound:s.mp3]',
]

# Media tags whose attribute run is ambiguous: a quote left unbalanced, or a
# quoted value hiding a `>` or a second `src=`. Anki reads the run as a
# sequence of either whole quoted segments or single non-`>` characters, so a
# value can be entered part way through and the first `src=` inside one wins.
MEDIA_TAG_CASES: list[str] = [
    # unbalanced quotes -- the value runs on, and the `src=` inside it is taken
    '<img alt="x src=y.png>',
    "<img alt='unclosed src=z.png>",
    '<img alt=" src=fake.png " src="real.png">',
    # a quoted value spanning a `>`, which does not end the tag
    '<img alt="a>b" src="c.png">',
    "<img alt='a>b' src='c.png'>",
    '<img alt=">" src="d.png">',
    # runs of quoted segments, the shape a backtracking engine explores twice
    # over: once as quotes, once as ordinary characters
    '<img "a""a""a" src="e.png">',
    '<img "a""a""a""a""a""a""a""a"',
    '<img ' + '"a"' * 12 + ' src="f.png">',
    # one quoting style inside the other
    '''<img alt='a"b' src="g.png">''',
    """<img alt="a'b" src='h.png'>""",
    # nothing a filename can be read out of, so the tag strips like any other
    '<img alt="">',
    "<img>",
    '<img src="">',
    # bare values next to another attribute
    "<img alt=x src=y.png>",
    '<img src="i.png" alt="j>">',
    # the same unbalanced quote in the other tag names
    '<audio alt="x src=k.mp3>',
    '<object alt="x data=l.swf>',
]

# One reference per name the decoder knows, so a change to the table shows up as
# a fixture diff rather than as a surprise in production.
ENTITY_CASES: list[str] = [f"&{name};" for name in sorted(NAMED_ENTITIES)]

# The decoder's boundaries: malformed, unterminated, and out-of-range forms,
# where guessing at the behaviour is exactly what goes wrong.
ENTITY_EDGE_CASES: list[str] = [
    # numeric forms
    "&#65;",
    "&#x41;",
    "&#X41;",  # uppercase X is not accepted
    "&#x2E;",
    "&#x2e;",
    "&#0;",
    "&#xffffff;",  # invalid code point
    "&#;",
    "&#",
    "&#32a;",
    "&#xfoo;",
    "&#-1;",
    "&#x;",  # the hex form with no digits at all
    # named forms
    "&Amp;",  # case matters
    "&amp",  # unterminated
    "&;",
    "&",
    "&&",
    "&amp;&amp;",
    "&amp hej",
    # surrogate / astral
    "&#x1F600;",
    "\U0001f600",
    "&#xD800;",  # a lone surrogate, which is not a code point
    "&#55296;",  # the same one in decimal
    # nbsp replacement -- the second case is a literal U+00A0, spelled with an
    # escape so it stays visible in a diff
    "&nbsp;&nbsp;",
    "a b",
    # interaction with tags
    '<img src="&amp;.png">',
    "&lt;img src=x&gt;",
    # entity inside a stripped region
    "<!-- &amp; -->",
    "<b>&amp;</b>",
]


def _deduped(*groups: list[str]) -> list[str]:
    """Concatenate the groups, keeping the first occurrence of each case.

    The groups overlap on purpose -- a few entity forms are worth reading in
    the hand-written list too -- but a duplicate input would make the generated
    fixture assert the same thing twice under the same test name.
    """
    seen: set[str] = set()
    out: list[str] = []
    for group in groups:
        for case in group:
            if case not in seen:
                seen.add(case)
                out.append(case)
    return out


CASES: list[str] = _deduped(LITERAL_CASES, MEDIA_TAG_CASES, ENTITY_CASES, ENTITY_EDGE_CASES)
