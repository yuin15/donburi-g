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

`src/view/WinSymbols.ts`が両者のWIN表示へモデルを配置します。ベルは小さく揺れ、チェリーは弾みます。次の回転ではその側のモデルを消し、先に飛び出したコインだけが飛び終わるようにしています。動きを減らす設定ではモデルを静止表示します。

`obj_export.py`は、Houdiniから書き出した同一の位置・UV・法線をまとめます。面の並びと部位名、面取りや硬い縁の法線を保ち、3モデルのOBJ合計は約566KBです。通常のゲーム開発ではOBJを再生成する必要はなく、Houdini未導入でも`npm run dev`で遊べます。

参考: [Houdini製品比較](https://www.sidefx.com/products/compare/)、[Apprenticeの条件](https://www.sidefx.com/get/try-houdini/)、[Python SOP](https://www.sidefx.com/docs/houdini/nodes/sop/python.html)。
