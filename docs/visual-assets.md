# Slot-chan ビジュアル素材

2026-09-12 / #36、#38。Codex内蔵の画像生成ツールで制作した専用素材。外部APIキーを使う生成CLIは使用していない。

参考画像は構図・質感の参照だけに使い、元の人物・名称・画像ファイルは再配布しない。ライバルは架空の成人。素材を利用するゲームコードはThree.jsで描画し、WebPへの縮小・圧縮だけをビルド準備で行った。元画像のEXIF等は転記しない。

|素材|用途|ライセンス/出所|
|---|---|---|
|`public/art/casino-stage.webp`|照明、筐体の彫刻・反射、操作台の焼き込み|本プロジェクト用に新規生成|
|`public/art/rival-expressions.webp`|同一人物の通常・自信・驚き・悔しさ、2×2アトラス|本プロジェクト用に新規生成|
|`public/art/symbols.webp`|チェリー・ベル・7、3×1アトラス|本プロジェクト用に新規生成|
|`public/art/coin.webp`|大当たりの金貨、透過テクスチャを24枚まで共有|本プロジェクト用に新規生成|

4点合計536,648 bytes。ステージ1672×941、人物1448×1086、絵柄1536×512、金貨256×256。Three.jsのmipmap込み概算テクスチャ量は約20.4MiB。

## 生成プロンプト

### Stage

```text
Use case: stylized-concept. Asset type: production background plate for a playable Three.js slot-duel game, landscape 16:9, 1536x864.
Use the attached image ONLY as a material, lighting and composition reference. Generate a new original scene, no people, no existing text, no logos, no digits.
A premium ornate 1930s casino, polished sculpted brass, black lacquer, warm amber lamps and rich dark navy shadows. Main slot machine occupies the left 60% of the frame; convincing heavy beveled metal, inset top crown, thick sculptural sides, gold trim, screws and burnished reflections. Camera almost straight on, slight view down onto a substantial protruding control plinth with a big oval ruby-red glass button in its center and a rectangular black-and-brass upgrade panel to its right. These control surfaces are empty, with NO text and NO symbols.
The machine has ONE EMPTY rectangular dark reel opening, precisely flat front facing, from approx x=12% to x=49% of the image and y=29% to y=70%. It is a clean EMPTY very dark rectangle with polished inset brass trim and two narrow dividing brass pillars at one-third and two-thirds; no reels or glyphs, because animated reels will be rendered over it by game code. No numbers anywhere.
Top 0–16% is a dark, subdued architectural backdrop with comfortable space for a HUD. The right 40% contains a large empty elegant portrait panel with a thin beveled brass frame, interior covering x=63% to x=96%, y=23% to y=74%, showing out-of-focus warmly lit casino interior only, no person. Below that is a black empty small horizontal rival-reel inset at x=65% to x=92%, y=78% to y=88%.
Full-bleed environment; no flat UI cards, no text of any sort, no lettering, no symbols in the reel opening. Restrained casino background depth; cinematic material quality, detailed but readable. The left machine control plinth is visible at y=78–93%, with dark front face and real contact shadows. Nothing cut off. This is a polished game asset, not a diagram or labeled wireframe.
```

### Rival

```text
Use case: photorealistic-natural. Asset type: game character expression atlas, a single 2-by-2 grid of FOUR equally sized landscape 4:3 portraits, overall 4:3 canvas, ideally 2048x1536. No gutters or borders between quadrants.
Create an ORIGINAL fictional adult Japanese woman in her late twenties as a friendly competitive slot-game rival. She has a distinctive chin-length dark chestnut bob, softly swept fringe, brown eyes, tasteful natural makeup, small gold earrings, a tailored black jacket with crimson piping over a modest black blouse. Warm cinematic casino lighting, amber from left with soft cool fill, realistic skin, high quality photographic game character art.
Each quadrant MUST depict the SAME woman, same outfit, same camera, same scale, same background and same light, framed as upper torso and head, face centered around 50% horizontal and 38% vertical in each panel, plenty of room above head, complete shoulders, hands only when naturally visible. She looks directly at the player. Background: deeply blurred dark navy and golden casino lamps, no readable signage.
Top-left: calm welcoming, slight natural smile, attentive.
Top-right: confident playful winning grin, slightly raised eyebrow.
Bottom-left: delightful surprise at the player's jackpot, open mouth, widened eyes, hands slightly raised near cheeks, not covering face.
Bottom-right: mock frustration after losing, pout and determined brows, still playful.
No text, no numbers, no logos, no labels, no watermarks, no gambling objects in foreground. This is a coherent sprite sheet, not a comic. The portraits should fill each quadrant and share exact framing for seamless expression changes. Do not resemble a celebrity or any reference person.
```

### Symbols

```text
Use case: stylized-concept. Asset type: production slot-machine symbol texture atlas, ONE row of exactly THREE equally sized square cells, overall canvas aspect ratio 3:1, ideally 1536x512.
From left to right: a pair of rich glossy red cherries with arcing stems and one dark green leaf; a sculpted polished golden brass bell; a bold classic lucky red numeral 7, slanted, beveled enamel with a thin cream and dark bronze outline.
Each symbol centered precisely within its own equal square cell, uniform 75% cell-size footprint, generous clean padding and no overlap. The entire background is one uniform warm ivory color #f3e6c9, no transparency, no panels, no cell lines, no floor shadow. Symbols have rich modeled volume, realistic lacquer and metal, clean edges, soft tiny ambient contact shading, warm light from upper-left and jewel highlights. Suitable for close-up rendering on curved ivory slot reels.
The cherries and bell should have the same glossy premium casino illustration style as the red 7. Avoid emoji appearance, flat clip art, black outlines, gradients in the BACKGROUND, extra symbols, decorative frames, captions, letters, logos and watermarks. Exactly three icons in a horizontal strip, with no other numerals besides the one red 7.
```
### Coin

```text
Use case: product-mockup. Asset type: transparent game coin sprite.
A single perfectly round, polished gold casino token, front-facing centered, ornate raised double rim, small raised 7 in the center, fine radial engraving and tiny repeating bevels. Thick sculpted edge, warm luminous gold highlights at upper-left, darker bronze shading at lower-right. Premium photorealistic 3D product rendering, matching a black lacquer and brass vintage slot machine. The token should occupy 86% of a square canvas. Full circle visible with generous transparent margin. Real alpha transparent background, no background, no ground plane, no cast shadow beyond the token, no lettering besides the one central numeral 7, no watermark, no extra objects. Bright and clearly legible when rendered at 35 pixels.
```
