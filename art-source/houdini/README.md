# Houdiniモデルの制作元

HoudiniのPython SOPで、厚みのある本体、二重の縁、刻みのある側面、面取りした両面の7を組み立てます。Houdini Apprentice 22.0.429で実際に生成・書き出し済みです。形状はスクリプトで再生成でき、特定のフォントや外部素材に依存しません。

`npm run dev` の起動後、`/art-source/houdini/preview.html` を開くと、ゲームと同じ形状・金属材質を拡大して確認できます。中央のコインは回転し、ボタンで停止できます。この確認ページは本番ビルドに含めません。

## 再生成

Houdiniをインストールし、無料のApprenticeライセンスを有効にしてから、Houdini付属の`hython`で次を実行します。

```powershell
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_coin.py
```

- `exports/slot-chan-coin.obj`: ゲームへ取り込む形状。Gitへ含めます。
- `.art-build/slot-chan-coin.hipnc`: 編集用のHoudiniシーン。リポジトリのルートに生成し、Gitへ含めません。

編集用シーンの`/obj/slot_chan_coin/procedural_coin`で、円周の分割数と側面の刻み数を変更できます。形状の断面と7の比率は`build_coin.py`で調整します。

`triangulate_for_web`で三角形化し、`OUT_COIN`からOBJを書き出します。既定の形状は2,956三角形。Three.jsでは1つの形状と反射マップを24枚のコインで共有し、当たり中に追加のモデル取得や形状生成を行いません。表示用の材質と照明は`src/view/GoldCoin.ts`、飛び方は`src/view/CabinetArt.ts`を変更します。

OBJは無料版で対応する書き出し形式です。制作に利用したApprenticeは非商用向けのため、この素材もゲームソンの非商用デモ向けとして扱ってください。商用化する場合は、制作ライセンスと素材の扱いをSideFXの条件に照らして確認してください。

アカウント情報、ライセンスファイル、個人のメールアドレスはGit対象に含めません。編集用のネイティブシーンもGit対象外とし、制作スクリプトから再生成します。

## ベルとチェリー

`build_symbols.py`で、開いた裾と内側・舌を持つベル、2つの実と曲がった茎・折れ目のある葉を持つチェリーを制作します。Houdini Apprentice 22.0.429で生成済みです。

```powershell
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_symbols.py
```

- `exports/slot-chan-bell.obj`: 3,872三角形。部位別に金色を調整します。
- `exports/slot-chan-cherry.obj`: 3,232三角形。果実のクリアコートと葉・茎の材質を分けます。
- `.art-build/slot-chan-symbols.hipnc`: 2モデルの編集用シーン。Python SOPの生成コードを埋め込んでおり、特定PCのパスに依存しません。
- `/art-source/houdini/symbols.html`: コインを含む3モデルの拡大プレビュー。回転と正面への復帰を操作できます。開発サーバー専用です。

材質とOBJ読み込みは`src/view/SymbolModels.ts`で管理します。外部のテクスチャやフォントは使いません。これらもApprenticeで制作した非商用デモ向け素材です。

`src/view/WinSymbols.ts`が両者のWIN表示へモデルを配置します。ベルは小さく揺れ、チェリーは弾みます。次の回転を予約していても、確定した獲得コインと同じ通常650msの間はモデルと金貨の演出を残します。動きを減らす設定ではモデルを短く静止表示します。

`obj_export.py`は、Houdiniから書き出した同一の位置・UV・法線をまとめます。面の並びと部位名、面取りや硬い縁の法線を保ち、コイン・ベル・チェリーのOBJ合計は約566KBです。通常のゲーム開発ではOBJを再生成する必要はなく、Houdini未導入でも`npm run dev`で遊べます。

## 7と筐体

`build_cabinet.py`で、金縁と赤いエナメル面を重ねた7、背面まで厚みを持つ筐体を制作します。Houdini Apprentice 22.0.429で生成済みです。7の輪郭はベジェ曲線、縁は丸い断面、筐体は奥へ絞った曲面で構成しています。

```powershell
& 'C:/Program Files/Side Effects Software/Houdini 22.0.429/bin/hython.exe' art-source/houdini/build_cabinet.py
```

| 出力 | 内容 |
| --- | --- |
| `exports/slot-chan-seven.obj` | 6,252三角形、321,351 bytes。曲線の輪郭、丸い金縁、暗い内縁、赤いエナメル面 |
| `exports/slot-chan-cabinet.obj` | 36,974三角形、1,982,633 bytes。丸い窓枠、曲面の側板と操作盤、装飾、背板、ボタン、レバー、脚、無地のドラム |
| `.art-build/slot-chan-cabinet.hipnc` | 2モデルを収めた編集用シーン。Git対象外。リポジトリのルートに生成 |

`/obj/slot_chan_seven/procedural_seven`と`/obj/slot_chan_cabinet/procedural_cabinet`が制作ノードです。Python SOPに生成コードを埋め込んでおり、編集用シーンを別のPCへ移しても元のスクリプトの絶対パスを必要としません。スクリプトから再生成する場合は、同じフォルダーの`build_symbols.py`と`obj_export.py`も使います。

筐体は前方を+Z、上を+Yとし、ゲームの100pxを1単位にしています。原点はゲーム座標の`(530, 870)`。`rectangle()`内で左上起点の画面座標から変換します。絵柄は高さ約2単位に揃えています。

OBJは形状と法線・部位名を保持し、材質はThree.js側で設定します。

- `seven_gold` / `seven_border` / `seven_enamel`: `src/view/SymbolModels.ts`で金属・内縁・エナメルを設定。
- `cabinet_*`: `src/view/CabinetModel.ts`で金属・濃いワイン色の塗装・黒いパネル・赤いボタンを設定。同じ材質の部位はまとめて描画。
- `cabinet_spin_button`: 押し込み用に独立。レバーの赤い持ち手は`cabinet_button`。
- `cabinet_reel_0`〜`2`: 拡大プレビュー用の無地ドラム。ゲーム側では省き、既存の下向き回転リールを表示。

正面にも側面と共通の材質を使い、筐体の面へ背景写真を貼る処理は撤去しました。金属には小さな加工目のテクスチャをコードで生成し、粗さと微細な凹凸へ使います。窓の薄いガラスはThree.js側で追加する透明な板で、OBJには含めません。ゲームの大きな背景画像は引き続き使用します。

`src/view/SymbolAtlas.ts`が、ベル・チェリー・7を起動時に一度だけ1536×512の画像へ描画します。両者の回転リールはこの共有画像を曲面へ貼り、WIN表示は元の立体モデルを使います。これで通常回転と当たりの絵柄を揃えています。回転中の絵柄自体を毎フレーム立体として描画する方式ではありません。HTMLの小さな配当アイコンは既存画像です。

`npm run dev`の後、`/art-source/houdini/cabinet.html`で2モデルを確認できます。ドラッグ・ホイールで回転と拡大、**Front / Three-quarter / Side / Back**で角度を切り替え、**Press SPIN**でボタンを押せます。このページは開発専用です。[仕上げ後のモデル・ゲーム画面・確認記録](../../docs/houdini-finish.md)、[初版の記録](../../docs/houdini-cabinet.md)。

参考: [Houdini製品比較](https://www.sidefx.com/products/compare/)、[Apprenticeの条件](https://www.sidefx.com/get/try-houdini/)、[Python SOP](https://www.sidefx.com/docs/houdini/nodes/sop/python.html)。
