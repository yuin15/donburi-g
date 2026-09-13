# Houdiniモデルの制作元

[採用リファレンス3枚](../../docs/art-reference/README.md)から、コイン・ベル・チェリー・7・筐体をHoudini Apprentice 22.0.429のPython SOPで制作。画像は制作目標であり、モデルに貼った筐体写真ではない。[実ゲームでの比較と確認](../../docs/game-art-direction.md)。

## 再生成

Houdini付属の `hython` で、リポジトリのルートから実行する。

```powershell
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_symbols.py
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_cabinet.py
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_coin.py
```

`build_symbols.py` が形状の共通部品、`build_cabinet.py` が7と筐体、`build_coin.py` が同じ7を両面に使ったコイン、`obj_export.py` がOBJの重複座標の整理を担当する。同じフォルダーのスクリプトをまとめて使う。

| 出力 | 三角形 | 主な造形 |
| --- | ---: | --- |
| `exports/slot-chan-cherry.obj` | 13,320 | 茎元のくぼみ、非対称の実、曲がる茎、立体の葉と金の葉脈 |
| `exports/slot-chan-bell.obj` | 10,042 | 丸い肩、厚い口と空洞、舌、二重の帯、星 |
| `exports/slot-chan-seven.obj` | 12,630 | 波打つ旗、太い脚、金銀の縁、盛り上がる赤い面 |
| `exports/slot-chan-coin.obj` | 16,252 | 両面の赤い7、二重の縁、側面の刻み、放射状の装飾、粒の縁 |
| `exports/slot-chan-cabinet.obj` | 81,043 | 上部アーチ、葉の彫刻、宝石、塗装・石材のパネル、操作盤、ボタン、側板、レバー、脚、無地ドラム |

OBJはGitに含める。`.art-build/slot-chan-symbols.hipnc`、`slot-chan-cabinet.hipnc`、`slot-chan-coin.hipnc` は編集用のネイティブシーンでGit対象外。生成コードをPython SOPへ埋め込むため、特定PCのパスに依存しない。アカウント・ライセンス・メールアドレスは含めない。通常のゲーム開発ではHoudiniなしで `npm run dev` を利用できる。

## Three.jsでの表示

- `src/view/SymbolModels.ts`：部位名から金属・エナメル・緑の葉などを設定。同じ材質の形状をまとめる。
- `src/view/FinishTextures.ts`：赤い塗装と緑の石材の色模様をコードで生成。
- `src/view/SymbolAtlas.ts`：起動時に3Dの絵柄を1536×512へ一度描画し、両者の回転リールで共有。回転中に個々の立体を再描画する方式ではない。
- `src/view/CabinetModel.ts`：筐体の塗装・金属・宝石・石材。`cabinet_spin_button` は押し込み用に独立。`cabinet_reel_*` はゲームでは省き、回転するリールを置く。
- `src/view/CasinoStage.ts`：ゲーム側のガラス照明、リールの凹みと仕切り、相手側の枠。
- `src/view/CabinetArt.ts`：当たり別のきらめき・光・コイン。コインの形状は24枚で共有し、当たり中に読み込まない。

筐体の前は+Z、上は+Y。ゲームの100pxが1単位、原点は画面の `(530,870)`。モデルの側面と背面にも奥行きを持たせる。ゲームの固定視点用に奥行きの投影を補正するが、絵柄の縦横比は補正から分離する。

## 拡大確認

`npm run dev` のURLで次を開く。いずれも本番ビルドには含めない。

- `/art-source/houdini/cabinet.html`：7と筐体。Front / Three-quarter / Side / Back、ドラッグとホイール、Press SPIN。
- `/art-source/houdini/symbols.html`：コイン・ベル・チェリー。回転と停止。
- `/art-source/houdini/preview.html`：コイン。
- `/?visual-review`：実ゲームの通常・各当たり・結果・字幕・回転計測。**完成判定はこちらのゲーム画面で行う。**

Apprenticeで制作した非商用ゲームソンのデモ向け素材として扱う。商用化時は[SideFXの条件](https://www.sidefx.com/get/try-houdini/)を確認する。[初版の制作記録](../../docs/houdini-cabinet.md)と[PR #107時点](../../docs/houdini-finish.md)は過去の状態。
