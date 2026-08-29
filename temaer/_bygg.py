# -*- coding: utf-8 -*-
"""Genererer ett demo-oppslag per fargetema. Typografi og layout holdes likt
   slik at fargen er det eneste som varierer."""
import io, os

TEMAER = [
  dict(
    id="grafitt", nr=1, navn="Grafitt",
    hvorfor="Termisk, strammet opp. Dypere flate, roligere gråtoner, og en varm-til-kald rampe som er det eneste kulørte på siden.",
    bunn="#16181A", hev="#1E2124", senk="#0F1113",
    blekk="#F0F1F2", blekk2="#ADB2B7", blekk3="#868C92",
    linje="#2A2E32", linje2="#383D42",
    ild="#FF6B3D", rav="#F0A63C", hav="#5B93E0", mose="#46A98C",
    ildv="#351E16", ravv="#332818", havv="#1A2739", mosev="#142C26",
    kort="Nærmest det du likte. Nøytral flate, fire klare signaler."),
  dict(
    id="graaskala", nr=2, navn="Gråskala",
    hvorfor="Ingen kulør noe sted. Hastegrad er ren lysstyrke — jo nærmere fristen, jo hvitere skinnen. Det reneste alternativet.",
    bunn="#121212", hev="#1A1A1A", senk="#0B0B0B",
    blekk="#F5F5F5", blekk2="#B0B0B0", blekk3="#8A8A8A",
    linje="#262626", linje2="#363636",
    ild="#FFFFFF", rav="#BDBDBD", hav="#7E7E7E", mose="#6A6A6A",
    ildv="#2E2E2E", ravv="#262626", havv="#1F1F1F", mosev="#1C1C1C",
    kort="Statusmerker skilles av ord, ikke farge. Strengest av alle."),
  dict(
    id="nattblaa", nr=3, navn="Nattblå",
    hvorfor="Kald blåsvart flate der bare det haster får glød. Alt lenger enn tre uker fram er nøytralt og stille.",
    bunn="#101722", hev="#16202D", senk="#0A1019",
    blekk="#E9EEF4", blekk2="#A8B6C6", blekk3="#7F8FA1",
    linje="#1F2B3A", linje2="#2B3949",
    ild="#FFA85E", rav="#D08B45", hav="#6E7C8C", mose="#6E8C82",
    ildv="#3A2A18", ravv="#33261A", havv="#1E2833", mosev="#1D2A27",
    kort="Én varm signalfarge mot kaldt. Rolig til langt fram er stille."),
  dict(
    id="sot", nr=4, navn="Sot",
    hvorfor="Varm brunsvart flate, som sot og glo. Fristen brenner oransje, det som ligger langt fram kjøler ned mot askeblått.",
    bunn="#16130F", hev="#1E1A15", senk="#100D0A",
    blekk="#F2EEE8", blekk2="#B8B0A5", blekk3="#918A80",
    linje="#2A251E", linje2="#38322A",
    ild="#FF7A45", rav="#CE8B3A", hav="#7391A8", mose="#7D9E7A",
    ildv="#3A2118", ravv="#33260F", havv="#1E2830", mosev="#202A1F",
    kort="Den eneste med varm grunntone. Papir- og blekkfølelse i mørket."),
  dict(
    id="dempet", nr=5, navn="Dempet",
    hvorfor="Myk koksgrå uten svarte hull, og aksenter med lav metning. Bygget for å stå åpen hele dagen uten å slite på øynene.",
    bunn="#202225", hev="#292C30", senk="#191B1E",
    blekk="#E4E6E8", blekk2="#A9AEB3", blekk3="#878D93",
    linje="#33373B", linje2="#41464B",
    ild="#D9705C", rav="#C2955A", hav="#6E96AD", mose="#6E9B84",
    ildv="#3A2A27", ravv="#362E23", havv="#26313A", mosev="#253128",
    kort="Lavest kontrast, minst drama. Behagelig over tid."),
]


# --- kontrast: markørfarger og tekstfarger er ikke det samme ---
def _lum(h):
    h=h.lstrip("#"); r,g,b=[int(h[i:i+2],16)/255.0 for i in (0,2,4)]
    f=lambda c: c/12.92 if c<=0.03928 else ((c+0.055)/1.055)**2.4
    return .2126*f(r)+.7152*f(g)+.0722*f(b)
def _cr(a,b):
    l1,l2=sorted([_lum(a),_lum(b)],reverse=True); return (l1+.05)/(l2+.05)
def _rgb(h):
    h=h.lstrip("#"); return [int(h[i:i+2],16) for i in (0,2,4)]
def _hx(v): return "#%02X%02X%02X" % tuple(max(0,min(255,int(round(c)))) for c in v)
def _juster(farge, flater, mork, mal_cr):
    """Nærmeste lysere/mørkere variant som klarer kravet mot alle flatene."""
    mot = [255,255,255] if mork else [0,0,0]
    c = _rgb(farge)
    for i in range(101):
        t = i/100.0
        k = _hx([c[j]+(mot[j]-c[j])*t for j in range(3)])
        if all(_cr(k,f) >= mal_cr for f in flater): return k
    return _hx(mot)

def utled(t):
    """Fyller ut tekstvariantene. Markørfargen får være sterk; teksten må leses."""
    mork = _lum(t["bunn"]) < 0.2
    flater = [t["bunn"], t["hev"]]
    for k, vask in (("ild","ildv"),("rav","ravv"),("hav","havv"),("mose","mosev")):
        # stolper og skinner er markører: 3:1 mot flaten holder
        if _cr(t[k], t["hev"]) < 3.05:
            t[k] = _juster(t[k], [t["hev"]], mork, 3.05)
        t[k+"t"] = _juster(t[k], flater + [t[vask]], mork, 4.6)
    t["blekk3"] = _juster(t["blekk3"], flater, mork, 4.6)
    t["blekk2"] = _juster(t["blekk2"], flater, mork, 4.6)
    return t

MAL = u"""<!doctype html>
<html lang="no"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{navn} — fargetema</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=Martian+Mono:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{{
  --bunn:{bunn}; --hev:{hev}; --senk:{senk};
  --blekk:{blekk}; --blekk-2:{blekk2}; --blekk-3:{blekk3};
  --linje:{linje}; --linje-2:{linje2};
  --ild:{ild}; --rav:{rav}; --hav:{hav}; --mose:{mose};
  --ild-t:{ildt}; --rav-t:{ravt}; --hav-t:{havt}; --mose-t:{moset};
  --ild-vask:{ildv}; --rav-vask:{ravv}; --hav-vask:{havv}; --mose-vask:{mosev};
  --sans:"Familjen Grotesk","Helvetica Neue",Arial,sans-serif;
  --mono:"Martian Mono",ui-monospace,Menlo,monospace;
}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bunn);color:var(--blekk);font-family:var(--sans);font-size:15px;line-height:1.45}}
a{{color:inherit}}
:focus-visible{{outline:2px solid var(--hav);outline-offset:2px}}

/* --- styrestripe: navigasjon mellom temaene --- */
.styre{{border-bottom:1px solid var(--linje);padding:18px 24px;display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center;justify-content:space-between}}
.styre__id{{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}}
.styre__nr{{font-family:var(--mono);font-size:11px;color:var(--blekk-3);letter-spacing:.08em}}
.styre__navn{{margin:0;font-size:21px;font-weight:700;letter-spacing:-.02em}}
.styre__hvorfor{{margin:6px 0 0;font-size:13.5px;color:var(--blekk-2);max-width:62ch;line-height:1.5}}
.styre__nav{{display:flex;gap:6px;align-items:center}}
.lenke{{padding:7px 12px;border:1px solid var(--linje-2);border-radius:3px;text-decoration:none;font-size:13px;font-weight:500;white-space:nowrap}}
.lenke:hover{{background:var(--senk)}}
.lenke--av{{opacity:.35;pointer-events:none}}
.pryd{{display:flex;gap:0;margin-top:14px;border-radius:3px;overflow:hidden;width:max-content;border:1px solid var(--linje)}}
.pryd i{{width:46px;height:22px;display:block}}

/* --- apputsnittet --- */
.ark{{max-width:1000px;margin:0 auto;padding:34px 24px 80px}}
.topp{{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;margin-bottom:22px}}
.merke{{margin:0;font-size:28px;font-weight:700;letter-spacing:-.024em;line-height:1}}
.merke span{{font-family:var(--mono);font-weight:400;font-size:.62em;color:var(--blekk-3);margin-left:.3em;vertical-align:.16em}}
.sum{{margin:9px 0 0;font-size:13.5px;color:var(--blekk-2)}}
.sum b{{font-family:var(--mono);font-weight:500;font-size:.94em;color:var(--blekk)}}
.knapper{{display:flex;gap:10px;align-items:center}}
.felt{{padding:8px 12px;background:var(--hev);border:1px solid var(--linje);border-radius:3px;color:var(--blekk-3);font-size:14px;width:190px}}
.knapp{{padding:8px 14px;background:var(--blekk);border:1px solid var(--blekk);color:var(--bunn);border-radius:3px;font-weight:600;font-size:14px;cursor:pointer;white-space:nowrap}}

/* fristlinjen */
.fl{{display:grid;grid-template-columns:1fr auto;background:var(--hev);border:1px solid var(--linje);border-radius:3px;margin-bottom:26px}}
.flate{{position:relative;height:96px;margin:16px 22px 0}}
.akse{{position:absolute;left:0;right:0;bottom:26px;height:1px;background:var(--linje-2)}}
.idag{{position:absolute;bottom:26px;top:2px;width:1px;left:0;background:var(--blekk);opacity:.5}}
.idagm{{position:absolute;top:-4px;left:0;font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--blekk-2)}}
.mnd{{position:absolute;bottom:4px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--blekk-3)}}
.stolpe{{position:absolute;bottom:26px;width:9px;margin-left:-4.5px;border-radius:4px 4px 0 0}}
.stolpe[data-h=naa]{{background:var(--ild)}}
.stolpe[data-h=snart]{{background:var(--rav)}}
.stolpe[data-h=senere]{{background:var(--hav)}}
.lop{{border-left:1px dashed var(--linje-2);padding:20px 22px;display:flex;flex-direction:column;justify-content:center}}
.lop b{{font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1}}
.lop span{{font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--blekk-3);line-height:1.5;max-width:88px}}

/* faner */
.faner{{display:flex;gap:2px;border-bottom:1px solid var(--linje);margin-bottom:6px}}
.fane{{padding:9px 12px 10px;border-bottom:2px solid transparent;color:var(--blekk-3);font-weight:500;font-size:15px}}
.fane[data-p]{{color:var(--blekk);border-bottom-color:var(--blekk);font-weight:600}}
.fane i{{font-family:var(--mono);font-size:11px;font-style:normal;margin-left:6px;opacity:.75}}

.bolk{{font-family:var(--mono);font-size:10.5px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--blekk-3);margin:32px 0 4px;padding-bottom:8px;border-bottom:1px solid var(--linje)}}
.bolk span{{float:right;font-weight:400}}

/* rader */
.gr{{display:grid;grid-template-columns:118px 1fr}}
.gutter{{padding:22px 18px 22px 0;text-align:right}}
.gutter em{{font-family:var(--mono);font-size:10px;font-style:normal;letter-spacing:.06em;text-transform:uppercase;color:var(--blekk-3);display:block}}
.gutter b{{font-family:var(--mono);font-size:20px;font-weight:500;letter-spacing:-.045em;display:block;margin-top:2px}}
.gutter i{{font-family:var(--mono);font-size:10px;font-style:normal;display:block;margin-top:5px}}
.rader{{border-left:2px solid var(--linje)}}
.gr[data-h=naa] .rader{{border-left-color:var(--ild)}}
.gr[data-h=snart] .rader{{border-left-color:var(--rav)}}
.gr[data-h=senere] .rader{{border-left-color:var(--hav)}}
.gr[data-h=ingen] .rader{{border-left-style:dashed;border-left-color:var(--linje-2)}}
.gr[data-h=naa] .gutter i{{color:var(--ild-t)}}
.gr[data-h=snart] .gutter i{{color:var(--rav-t)}}
.gr[data-h=senere] .gutter i,.gr[data-h=ingen] .gutter i{{color:var(--blekk-3)}}
.gr[data-h=ingen] .gutter b{{font-size:13px;letter-spacing:0;color:var(--blekk-2)}}
.rad{{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;padding:14px 14px 14px 20px;border-bottom:1px solid var(--linje)}}
.rad:last-child{{border-bottom:0}}
.rad strong{{font-weight:600;letter-spacing:-.012em;font-size:15px;display:block}}
.rad a{{color:var(--blekk-2);text-decoration:none;font-size:14.5px}}
.rad a:hover{{color:var(--blekk);text-decoration:underline}}
.meta{{margin-top:6px;font-size:12.5px;color:var(--blekk-3)}}
.meta s{{text-decoration:none;color:var(--linje-2);margin:0 6px}}
.lapp{{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 7px;border-radius:100px;font-size:11.5px;font-weight:500;white-space:nowrap;background:var(--senk);color:var(--blekk-2)}}
.lapp::before{{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}}
.lapp[data-s=sendt]{{background:var(--mose-vask);color:var(--mose-t)}}
.lapp[data-s=avslag]{{background:var(--ild-vask);color:var(--ild-t)}}
.lapp[data-s=intervju]{{background:var(--hav-vask);color:var(--hav-t)}}
.mini{{padding:6px 10px;border:1px solid var(--linje-2);border-radius:3px;font-size:13px;color:var(--blekk-2);background:var(--hev)}}

/* tall */
.fliser{{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--linje);border:1px solid var(--linje);border-radius:3px;overflow:hidden;margin:34px 0 20px}}
.flis{{background:var(--hev);padding:18px}}
.flis em{{font-style:normal;font-size:12.5px;color:var(--blekk-3);display:block;margin-bottom:8px}}
.flis b{{font-size:32px;font-weight:600;letter-spacing:-.035em;line-height:1;display:block}}
.flis u{{text-decoration:none;font-size:12.5px;color:var(--blekk-2);display:block;margin-top:7px}}
.flis[data-v] b{{color:var(--ild-t)}}
.kort{{background:var(--hev);border:1px solid var(--linje);border-radius:3px;padding:20px 22px 22px}}
.kort h3{{margin:0;font-size:15.5px;font-weight:600;letter-spacing:-.012em}}
.kort p{{margin:3px 0 20px;font-size:12.5px;color:var(--blekk-3)}}
.soyler{{display:flex;align-items:flex-end;gap:2px;height:120px;padding-top:20px}}
.soyle{{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;position:relative}}
.soyle div{{width:100%;max-width:24px;border-radius:4px 4px 0 0;background:var(--hav)}}
.soyle span{{position:absolute;font-family:var(--mono);font-size:10.5px;color:var(--blekk-2)}}
.hakk{{display:flex;gap:2px;border-top:1px solid var(--linje-2);padding-top:7px}}
.hakk span{{flex:1;text-align:center;font-family:var(--mono);font-size:9.5px;color:var(--blekk-3)}}

@media (max-width:720px){{
  .ark{{padding:24px 16px 60px}} .fl{{grid-template-columns:1fr}}
  .lop{{border-left:0;border-top:1px dashed var(--linje-2);flex-direction:row;align-items:center;gap:12px}}
  .lop span{{max-width:none}}
  .gr{{grid-template-columns:1fr}} .gutter{{text-align:left;padding:20px 0 8px;display:flex;align-items:baseline;gap:9px}}
  .gutter b,.gutter i{{margin-top:0}} .fliser{{grid-template-columns:1fr 1fr}}
}}
</style></head><body>

<div class="styre">
  <div>
    <div class="styre__id"><span class="styre__nr">TEMA {nr} AV 5</span><h1 class="styre__navn">{navn}</h1></div>
    <p class="styre__hvorfor">{hvorfor}</p>
    <div class="pryd">{pryd}</div>
  </div>
  <div class="styre__nav">
    <a class="lenke {avf}" href="{forrige}">← Forrige</a>
    <a class="lenke" href="index.html">Alle fem</a>
    <a class="lenke {avn}" href="{neste}">Neste →</a>
  </div>
</div>

<div class="ark">
  <div class="topp">
    <div>
      <h2 class="merke">Jobbsøknader <span>2027</span></h2>
      <p class="sum"><b>30</b> å søke på · <b>20</b> sendt · <b>5</b> arkivert · neste frist <b>28.08</b> Aker BP</p>
    </div>
    <div class="knapper"><span class="felt">Søk selskap eller stilling</span><span class="knapp">Legg til søknad</span></div>
  </div>

  <div class="fl">
    <div><div class="flate">
      <div class="akse"></div><div class="idag"></div><span class="idagm">i dag</span>
      <span class="mnd" style="left:0">aug</span>
      <span class="mnd" style="left:14.5%;padding-left:5px">sep</span>
      <span class="mnd" style="left:69%;padding-left:5px">okt</span>
      <div class="stolpe" data-h="naa"    style="left:7.3%;height:27px"></div>
      <div class="stolpe" data-h="naa"    style="left:10.9%;height:20px"></div>
      <div class="stolpe" data-h="naa"    style="left:12.7%;height:20px"></div>
      <div class="stolpe" data-h="snart"  style="left:36.4%;height:47px"></div>
      <div class="stolpe" data-h="snart"  style="left:38.2%;height:20px"></div>
      <div class="stolpe" data-h="senere" style="left:56.4%;height:20px"></div>
      <div class="stolpe" data-h="senere" style="left:67.3%;height:60px"></div>
      <div class="stolpe" data-h="senere" style="left:69.1%;height:34px"></div>
      <div class="stolpe" data-h="senere" style="left:94.5%;height:20px"></div>
    </div></div>
    <div class="lop"><b>8</b><span>løpende<br>ingen frist</span></div>
  </div>

  <div class="faner">
    <span class="fane" data-p>Frister <i>30</i></span><span class="fane">Sendt <i>20</i></span>
    <span class="fane">Arkiv <i>5</i></span><span class="fane">Tall</span>
  </div>

  <p class="bolk">Etter frist <span>22</span></p>

  <div class="gr" data-h="naa">
    <div class="gutter"><em>fre.</em><b>28.08</b><i>om 4 dager</i></div>
    <div class="rader">
      <div class="rad"><div><strong>Aker BP</strong><a href="#">Graduate: Life Cycle Data Services ↗</a>
        <div class="meta">Oslo / Trondheim<s>·</s>Energi og industri</div></div>
        <span class="mini">Merk sendt</span></div>
      <div class="rad"><div><strong>Cogito NTNU</strong><a href="#">Opptak høst 2026</a>
        <div class="meta">Trondheim<s>·</s>Verv og studentorg</div></div>
        <span class="mini">Merk sendt</span></div>
    </div>
  </div>

  <div class="gr" data-h="snart">
    <div class="gutter"><em>søn.</em><b>13.09</b><i>om 20 dager</i></div>
    <div class="rader">
      <div class="rad"><div><strong>Visma</strong><a href="#">Summer internship 2027 ↗</a>
        <div class="meta">Oslo<s>·</s>Teknologi<s>·</s><em style="font-style:italic">frist kl. 12:00</em></div></div>
        <span class="mini">Merk sendt</span></div>
    </div>
  </div>

  <div class="gr" data-h="senere">
    <div class="gutter"><em>ons.</em><b>30.09</b><i>om 37 dager</i></div>
    <div class="rader">
      <div class="rad"><div><strong>Bekk</strong><a href="#">Nyutdannede, data og analyse ↗</a>
        <div class="meta">Oslo<s>·</s>Konsulent</div></div>
        <span class="mini">Merk sendt</span></div>
    </div>
  </div>

  <div class="gr" data-h="ingen">
    <div class="gutter"><em>frist</em><b>ingen</b><i>søk når du vil</i></div>
    <div class="rader">
      <div class="rad"><div><strong>Cognite</strong><a href="#">Data Scientist ↗</a>
        <div class="meta">Oslo<s>·</s>Teknologi</div></div>
        <span class="lapp" data-s="intervju">Intervju</span></div>
      <div class="rad"><div><strong>Sopra Steria</strong><a href="#">AI Engineer ↗</a>
        <div class="meta">Oslo<s>·</s>Konsulent</div></div>
        <span class="lapp" data-s="avslag">Avslag</span></div>
      <div class="rad"><div><strong>Statnett</strong><a href="#">Data Scientist ↗</a>
        <div class="meta">Oslo<s>·</s>Energi og industri</div></div>
        <span class="lapp" data-s="sendt">Sendt</span></div>
    </div>
  </div>

  <div class="fliser">
    <div class="flis" data-v><em>Neste frist</em><b>4 dager</b><u>Aker BP · 28. august</u></div>
    <div class="flis"><em>Å søke på</em><b>30</b><u>22 med frist · 8 løpende</u></div>
    <div class="flis"><em>Sendt</em><b>22</b><u>9 % har svart</u></div>
    <div class="flis" data-v><em>Frister denne uka</em><b>4</b><u>Aker BP, Cogito NTNU og 2 til</u></div>
  </div>

  <div class="kort">
    <h3>Fristtrykk de neste ti ukene</h3>
    <p>Antall frister per uke. Toppene er ukene du må planlegge rundt.</p>
    <div class="soyler">
      <div class="soyle"><span style="bottom:calc(30% + 6px)">3</span><div style="height:30%"></div></div>
      <div class="soyle"><span style="bottom:calc(10% + 6px)">1</span><div style="height:10%"></div></div>
      <div class="soyle"><span style="bottom:calc(50% + 6px)">5</span><div style="height:50%"></div></div>
      <div class="soyle"><span style="bottom:calc(10% + 6px)">1</span><div style="height:10%"></div></div>
      <div class="soyle"><span style="bottom:calc(10% + 6px)">1</span><div style="height:10%"></div></div>
      <div class="soyle"><span style="bottom:calc(100% + 6px)">10</span><div style="height:100%"></div></div>
      <div class="soyle"><div style="height:1.5%;background:var(--senk)"></div></div>
      <div class="soyle"><span style="bottom:calc(10% + 6px)">1</span><div style="height:10%"></div></div>
      <div class="soyle"><div style="height:1.5%;background:var(--senk)"></div></div>
      <div class="soyle"><div style="height:1.5%;background:var(--senk)"></div></div>
    </div>
    <div class="hakk"><span>35</span><span>36</span><span>37</span><span>38</span><span>39</span><span>40</span><span>41</span><span>42</span><span>43</span><span>44</span></div>
  </div>
</div>
</body></html>
"""

def pryd(t):
    return "".join('<i style="background:%s"></i>' % c
                   for c in [t["bunn"], t["hev"], t["ild"], t["rav"], t["hav"], t["mose"], t["blekk"]])

TEMAER = [utled(t) for t in TEMAER]

for i, t in enumerate(TEMAER):
    f = TEMAER[i-1]["id"] + ".html" if i > 0 else "index.html"
    n = TEMAER[i+1]["id"] + ".html" if i < len(TEMAER)-1 else "index.html"
    ut = MAL.format(pryd=pryd(t), forrige=f, neste=n,
                    avf="lenke--av" if i == 0 else "", avn="lenke--av" if i == len(TEMAER)-1 else "", **t)
    io.open(t["id"] + ".html", "w", encoding="utf-8").write(ut)
    print("skrev", t["id"] + ".html")
