"""Lager appikonene fra src-tauri/icons/kilde.png.

Kilden er et kantløst kvadrat. macOS forventer at ikonet selv har
formen: et avrundet kvadrat på 824 av 1024 piksler, med luft rundt
til skyggen. Uten den blir ikonet en skarp flis i Dock, ved siden av
alle de andre som er avrundet.

Bruk:  python3 scripts/lag-ikon.py
Skriver src-tauri/icons/master.png (et mellomtrinn, ikke sjekket inn)
og src/felles/ikon.png. Kjør deretter
`npx tauri icon src-tauri/icons/master.png` og behold filene som
tauri.conf.json lister.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROT = Path(__file__).resolve().parent.parent
KILDE = ROT / "src-tauri/icons/kilde.png"
MASTER = ROT / "src-tauri/icons/master.png"
FANEIKON = ROT / "src/felles/ikon.png"

STR = 1024
FLATE = 824
MARG = (STR - FLATE) // 2
RADIUS = 185
SKALA = 4


def avrundet_maske(storrelse, radius):
    stor = Image.new("L", (storrelse * SKALA, storrelse * SKALA), 0)
    ImageDraw.Draw(stor).rounded_rectangle(
        (0, 0, storrelse * SKALA - 1, storrelse * SKALA - 1), radius * SKALA, fill=255)
    return stor.resize((storrelse, storrelse), Image.LANCZOS)


def main():
    kilde = Image.open(KILDE).convert("RGBA").resize((FLATE, FLATE), Image.LANCZOS)
    maske = avrundet_maske(FLATE, RADIUS)
    kilde.putalpha(ImageChops.multiply(kilde.getchannel("A"), maske))

    skygge = Image.new("RGBA", (STR, STR), (0, 0, 0, 0))
    skyggemaske = Image.new("L", (STR, STR), 0)
    skyggemaske.paste(maske, (MARG, MARG + 12))
    skygge.putalpha(skyggemaske.point(lambda a: a * 0.32).filter(ImageFilter.GaussianBlur(14)))

    master = Image.alpha_composite(skygge, Image.new("RGBA", (STR, STR), (0, 0, 0, 0)))
    master.alpha_composite(kilde, (MARG, MARG))
    master.save(MASTER)

    kilde.resize((32, 32), Image.LANCZOS).save(FANEIKON)


if __name__ == "__main__":
    main()
