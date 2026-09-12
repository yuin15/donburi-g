# 立体コインの制作元

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

参考: [Houdini製品比較](https://www.sidefx.com/products/compare/)、[Apprenticeの条件](https://www.sidefx.com/get/try-houdini/)、[Python SOP](https://www.sidefx.com/docs/houdini/nodes/sop/python.html)。
