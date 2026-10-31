import io
import json
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def main():
    output = {}
    for optical in (48, 72):
        font = TTFont('design/brand/fonts/fraunces-latin.woff2')
        font.flavor = None
        font = instantiateVariableFont(font, {'wght': 600, 'opsz': optical, 'WONK': 0, 'SOFT': 0}, inplace=True)
        output[str(optical)] = outline(font, ('Piano', 'Duet'))
    font = TTFont('design/brand/fonts/atkinson-hyperlegible-next-latin.woff2')
    font.flavor = None
    font = instantiateVariableFont(font, {'wght': 600}, inplace=True)
    output['atkinson'] = outline(font, ('Real music. Fresh every time.', 'Practice at your piano · Private on your device · Free and open'))
    json.dump(output, sys.stdout)


def outline(font, strings):
    buffer = io.BytesIO()
    font.save(buffer)
    face = hb.Face(buffer.getvalue())
    shaping = hb.Font(face)
    shaping.scale = (font['head'].unitsPerEm, font['head'].unitsPerEm)
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    words = {}
    for word in strings:
        text = hb.Buffer()
        text.add_str(word)
        text.guess_segment_properties()
        hb.shape(shaping, text)
        x = 0
        paths = []
        for info, position in zip(text.glyph_infos, text.glyph_positions, strict=True):
            pen = SVGPathPen(glyphs)
            glyphs[order[info.codepoint]].draw(pen)
            paths.append({'d': pen.getCommands(), 'x': x + position.x_offset, 'y': position.y_offset})
            x += position.x_advance
        words[word] = {'advance': x, 'paths': paths}
    return {'upem': font['head'].unitsPerEm, 'words': words}


if __name__ == '__main__':
    main()
