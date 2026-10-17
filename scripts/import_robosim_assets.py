#!/usr/bin/env python3
"""Copy a pinned RoboSimStudio YAM asset subset, or verify the imported bytes.

No upstream Python, build hook, or installer is run. Clone/read the pinned
repository separately, then pass its directory with --source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import xml.etree.ElementTree as ET

UPSTREAM_URL = "https://github.com/robosimstudio/robosimstudio"
UPSTREAM_SHA = "73739abe212f963e8a9f5862b27bca370df091a7"
MODEL = Path("assets/embodiments/yam_i2rt")
EXPECTED = {
    "base.stl": "7d57efce4cd31db5e461e1bc83362943a7dbe0e8e101cdb94c29de0a72f3ff0f",
    "gripper.stl": "d949c401186197d842ca8f9b23bfcbf24bed8461b421df06093c65e4ead21f5d",
    "link1.stl": "2283bab1300cfdd1a04aaf09503093d7d6d19bf2144abf3429d563b596920903",
    "link2.stl": "4fd4df2916be71391c6c6ea6ffbdb3c270ce67c71c2bb7d42d44736c0be2af98",
    "link3.stl": "5b51658509771514738d0f2271df5f271cd8ae0b6a4bf3787d8463d5ab582593",
    "link4.stl": "f6e980b8064a1396b17e87065de50286abf616f94b55e1ccff92e889218de220",
    "link5.stl": "b32ece2e963cd028d68290a904223826070be52ce8f0988e3ad36bf75be3582f",
    "tip_left.stl": "03d94f53d7b5e9e1871ea6f3925c68d7a2f894b08e0c575fa0b9ed4024684ff7",
    "tip_right.stl": "8f620aae9c15e00e2ea4e5bf5e9a49e7edb2d23128b8955cfacc0da8da45c72f",
}

# Fixed Python-only core allowlist and byte hashes at UPSTREAM_SHA.
RUNTIME_EXPECTED = {
    "robosimstudio/__init__.py": "7baf6a44723dd856bd9bc94bb00a7d4ccbb72aca80077819a5375eecd50eb7da",
    "robosimstudio/_version.py": "543b0fd4509ba2fae24c3922c8626f3767975513e87662baece72e7fa2e8c5d0",
    "robosimstudio/arms.py": "5f724543201ae1af0b8ffb8848aee228121e9fc0f0050ddf60835755d753c0ac",
    "robosimstudio/assetlib/__init__.py": "02c66100d12dbc0d793e1869982deaa9b4b3a63283dd321f10cce05ab98d5ccd",
    "robosimstudio/assetlib/interface.py": "405102bbb89b37542c8754fa84c3ab02097f4eddc4d6fb929c961b1b9b0ae9b3",
    "robosimstudio/assetlib/lower.py": "03a892b5a878369ff9596fa4199b22ab403530dec7ce55bd3fbbf5aba939ff9d",
    "robosimstudio/assetlib/materials.py": "182ddf123828225ca447594ad1c5e0903bf44817132fd7c2325ce52d2706aaf2",
    "robosimstudio/assetlib/record.py": "47680da0c7353595e0931e7cbf637bdfd8dbfaef295cf72c39c4a5d61c8c73ae",
    "robosimstudio/assetlib/registry.py": "525f77f9334a0ed4cb1b693e85c85f5670851feee51798b96eaf766aa18ee5b3",
    "robosimstudio/assetlib/semantics/__init__.py": "02a36c521f708007efd22e4c341f7e030460fca3a4aedad8172d782ddbaefea8",
    "robosimstudio/assetlib/semantics/atom.py": "0aaa69beb9e208a5cd04e60f4adaa1f5514ddd2763643f16f1a94b704aab48ea",
    "robosimstudio/assetlib/semantics/atoms.py": "c136e49fca69d49ccd3ab812914ebade3c17f95b9608d82f8bce6aef61376844",
    "robosimstudio/assetlib/semantics/features.py": "a18757831f46d9e7f7dfddb3eed1e09e13643eab131608402ef3bd0970025c88",
    "robosimstudio/assetlib/semantics/handlers.py": "7150826f1b726325af83c7330ad1bacebad137df58e3b1fde9877b379d87560f",
    "robosimstudio/assetlib/semantics/kinds.py": "fb3750a62f071713c885acf56150478191d2e5daa8205266c53727a6b8918ac1",
    "robosimstudio/assetlib/semantics/library.py": "3532bdeeb6c4f860edcb01cc7f2d8a56c4fe8ea2827e0429c3136957d89dae1b",
    "robosimstudio/assetlib/semantics/published.py": "530935848283b7fa1ad34bf7573775b0ef1702c2930bae87bf0fb5e4f858cdd0",
    "robosimstudio/assetlib/semantics/resolve.py": "194b85167066ce482c5cb1ab12c224b3d5091f24a8d220e459728728e70baa0d",
    "robosimstudio/assetlib/semantics/selectors.py": "9e817a0cc4731bbb1abc98e2f3a79d629604712e015a40c3ce14792844561f39",
    "robosimstudio/assetlib/semantics/snapshot.py": "37913a3e23f1c0648d301dd4561919e4670b0dfd96da81125d3ad32138671d89",
    "robosimstudio/assetlib/semantics/states.py": "ecfb22a6eda6dfcb072a0b60467893863b0827f4cdf6b55d2b60665db97ca33b",
    "robosimstudio/assetlib/semantics/substrates.py": "eb7c19bf5d0d7bd3c060c1a0e2318cfbc56c46da0b8264e32016fb05656f9977",
    "robosimstudio/assetlib/sim.py": "935c77c2cc295f0c49aa4dcbbfe47a8a472eea5b1ad523a34347b44a9b54e976",
    "robosimstudio/assetlib/vocabulary/__init__.py": "9a72607be13c78a124857f4bd2120082c610eba322b4e7b52ca601b63caef1df",
    "robosimstudio/assetlib/vocabulary/coverage.py": "18bf12db40123a2c5b0f394c46150c8e808f59cb71edaab56793e83df26011ef",
    "robosimstudio/assetlib/vocabulary/measures.py": "0746cd7b54546335cbf7577235910d8868b9026400d95eeaeb12c1761e09720a",
    "robosimstudio/assetlib/vocabulary/motion.py": "c24823927e34202443beffbe5c26fe4411380166d9620d6f30d0c929839b53e4",
    "robosimstudio/assetlib/vocabulary/regions.py": "18d17c38ab7b8a976364dfccc0cdc31b2d87e62e0ed872eebc4625512a0684e5",
    "robosimstudio/core/__init__.py": "3dbac0fcd4e7cb753f5fb74cf62009ab7d598a8a6a35066ce9ac008fbcd07f4b",
    "robosimstudio/core/builder.py": "10eb5221994a9b941b81b3b4c97e77228236d42bd9fa57b1f90ed11b818be531",
    "robosimstudio/core/bus.py": "2145e8f793eebef37e0004b3a55a988c582b09ba01ffc9a2d867fac8f99ae261",
    "robosimstudio/core/cameras.py": "1ac003b377cb5d0b211cd1d5d1f802aa1d50b0e19c11f735c21cc45c41bafb9b",
    "robosimstudio/core/draggers.py": "f227f623c90a9c71f98529c672c93921d4f6fa3ebeb411d23ff6323cfc8b2601",
    "robosimstudio/core/env.py": "7677292de692a24ef337bf947e76646a1739bdbcad0c2d75c1932d4161e05ecb",
    "robosimstudio/core/lifecycle.py": "88c7b2f4e809078e9185b7947a5cd03ca08f55f84c2aeafb2a3cb96f0cd7afcb",
    "robosimstudio/core/math.py": "7e2c74886b539144d7bc55711289edc2757a1cf0332593342720400cb2efd5f6",
    "robosimstudio/core/pipeline.py": "0f58dfd5e39cc7a937feda97694a0c21a65b06a01b097f27102036e7db649e55",
    "robosimstudio/core/probes/__init__.py": "231794d8de1debb5c0d6250b99c69039386dcfdcd9fa27f2c0a6617f77e5d4f4",
    "robosimstudio/core/probes/clearance.py": "676e135dd314b3a9ab682acda8ccb32ca8e344cd975fe086b0040ccfca94969f",
    "robosimstudio/core/probes/contact.py": "c2cfb27f3293c752f140170f280556131448f02a7c34047d6cc17f041ac1dc8f",
    "robosimstudio/core/probes/particle.py": "9f38155a233543a6f03dbe16beae7cbca925706bbbf2d2d88155ffc3766dc21a",
    "robosimstudio/core/profile.py": "5d5389b022ba2e18c8820088155689c234a41ef9467b91346f80a0a5a1455ad3",
    "robosimstudio/core/readback.py": "64c17901709281d1c45929d94df1489352ca85b512c10c8af77f4ca8b3427b3d",
    "robosimstudio/core/render/__init__.py": "1e60dec7b1874a3de2acc46ea68d13f7c3241b9ae7f82f6865e5d79630f1c783",
    "robosimstudio/core/render/base.py": "7bb15b0aef5687e5275052d40d5e107c0eefbc2ef7f40bae16bc9c98a3230336",
    "robosimstudio/core/render/finish.py": "d3ef3a4ac01b4d9da9e86973b1865b229cc78f7086afe1cefa13e5972fa73b08",
    "robosimstudio/core/render/live.py": "677c051fa699a6d55ecf1668e7521db10e3e03a1c92a4bdfd2b7f1117df35c47",
    "robosimstudio/core/render/look.py": "0f29dcaa582f7145ce295fe3ea1eafa52a69e578ea121045d38d08cdc3aa89ab",
    "robosimstudio/core/render/offline.py": "b515635e32ca99b47fe73c46be600cd48d95668cdb6d7de3f6ac858cd15702d2",
    "robosimstudio/core/render/palette.py": "2755574187a58c02b9c9ec605cfc86eea7eb9621bfa704175f3865d3161a57c7",
    "robosimstudio/core/render/room.py": "1ce3b6b308bb379746c9a08aa5805990708fac949bc8068a5ecd808b4ff1c183",
    "robosimstudio/core/render/scenery.py": "95ed11dfbbc90e1ed2c85c0cf5f273ac835d69d7db03551927943d6b6a7290d2",
    "robosimstudio/core/render/spec.py": "227d6cfb0659337d3c73544dd6f7e130d1aee223928f67598f9fa3acc63a7c21",
    "robosimstudio/core/render/uv.py": "992f362dc3ecddd0d6e739294fcc2548c22eaf26bdb3c22b261674fdc3dabfb0",
    "robosimstudio/core/render/video.py": "660f0b99ea2399ef335d886c74015f94d3df97907ebc6ec48fb7b8d9a9d7d744",
    "robosimstudio/core/render/visual.py": "78df8ff91ca27e632ad588fbd3d06d6a71e288a71d7bb201dc49b1065117d587",
    "robosimstudio/core/schedule.py": "5774f15cd603c5716583b63cf80e79422eb81c60dbcc31458b640b1d6396e8d6",
    "robosimstudio/core/shell.py": "7f5b40cf8741e2cc8f2ccdb9f63047bc295cb7dcd1a8004df047e70e07f1afbc",
    "robosimstudio/core/streams.py": "e976c93bacff7158a12aaa29004110be3d913c6f4f5b121fd4bc7fc83a58b994",
    "robosimstudio/core/tuning.py": "66dee7719dc44e039005614684a7332596f765b91b95071afe1de17780f52d39",
    "robosimstudio/core/worlds.py": "5c68e29a86c2fef9c87d13fca37133b50641d68613c152756b75b74b2d5d2841",
    "robosimstudio/domains/__init__.py": "6387bf29bfb05300c0bcdbb63c3586a6da00c455999e169eae75dbe86a8567f0",
    "robosimstudio/domains/articulated/__init__.py": "2c00a7ebbb3641480cd8635de4f0f857f44e36a6f7cf30d500965d1260b946c9",
    "robosimstudio/domains/articulated/measures.py": "7890067398baa2799580d03f1f47973e9bf99962dc56ef504123f68bf106c085",
    "robosimstudio/domains/capabilities.py": "d984a7e64f0732f458faa7dab9f93d6472c84e97f045577cd691f27c487c0831",
    "robosimstudio/domains/rigid/__init__.py": "4f317f5ae981d0542ea3cbd92e325c9aa91991a457eec1c63d2c791a7d190d49",
    "robosimstudio/domains/rigid/declare.py": "36c34fd1583409695aab4a8becea2ddfad99a9308c04df734aa1175daa8c2f0a",
    "robosimstudio/domains/rigid/entity.py": "c8436cdfd97c5a233a454ae618ddc518582e0ab345b1c0661c16f8c3dc753568",
    "robosimstudio/domains/rigid/make.py": "b24e9fcfec9a7afe6a3088142b6993ded87c830bf320d8031309d2b440589fe5",
    "robosimstudio/domains/rigid/measures/__init__.py": "e05d35319fea1b23b6ca1f281964e7d8e06b6043663454a4c1861e80fcf1ea11",
    "robosimstudio/domains/rigid/measures/geometry.py": "43e1fbc84daaf88912a4c9a821b417eb2dd9b745aa369030f5c221386b230ef6",
    "robosimstudio/domains/rigid/measures/insertion.py": "f24be96a6de577da81a01a9d2bad6acd41323ef1089823cd035ed34032e09b8e",
    "robosimstudio/domains/rigid/measures/jaws.py": "cc3eedd7ebf65b4281bc76b2af079cd6cef095b59850cfd367fd44923c86c2b6",
    "robosimstudio/domains/rigid/measures/placement.py": "93db25309fd1901aea000f0bb688a65304656bc58932bf1bb5da24415aae59ea",
    "robosimstudio/domains/rigid/measures/regions.py": "8b4f6650dd1fd7611b3c4b6445f58cc16fbbf73878f4840348978ebb2ee8a5b3",
    "robosimstudio/domains/selection.py": "72e7613370cc4ee66c0b539c1630eacf1390512c2e79bb9b72d6e2977a031a5b",
    "robosimstudio/domains/static/__init__.py": "5ef593ebe3113c760f1eac405fbb5ceae28c0d36c694390d64891caccdd0af53",
    "robosimstudio/domains/static/entity.py": "726b2adf932decc0f25e0080a16751a275baeb96dd25c44610fa9365f0974153",
    "robosimstudio/domains/static/make.py": "5adc485bc50eda28a0246049801c7e1c65738531e64b795fb5efa75f0bb4be4a",
    "robosimstudio/domains/static/posts.py": "f2155bec258a5de4c87027a2138473b136ddddf6e4cf25e3faa6c15a40c2f190",
    "robosimstudio/domains/static/welded.py": "355c1bac9cd6f916e8825e096b168ffaacbbeb7e7e3ca25d8e6b95fa71fc394e",
    "robosimstudio/engines/__init__.py": "7ef07ce719e683c05f23089aaa5ed99e0a7831eb7a8df420cade7154c2b0117f",
    "robosimstudio/engines/contract.py": "274e7fdd8342f9b4e9568b3d9e5850318f7cdfe915710eb3ff9907c8dc1ad71f",
    "robosimstudio/engines/cosim.py": "455f40f48f6e1e8ac3f2d3ec6ae5f73cd2822be50f5dbf7ff33a876c230652d6",
    "robosimstudio/engines/feedback.py": "2d1f84ba5a6a1e5945582bf66d4b632034afde2b139867bc8faf49e209664c6b",
    "robosimstudio/engines/genesis/__init__.py": "8dc984eff29757c49de141de7ac00053c30b4b94dab07b49a78b06f13c9a7207",
    "robosimstudio/engines/genesis/bridge.py": "b819efca3b4b19464e6c16c8417398526996a6aaea624ae2ecd2aef9ae371cd7",
    "robosimstudio/engines/genesis/runtime.py": "2f651492449200f80b8c565080d701aa7ed41dc61737b12cb07fe7935a8bbf8d",
    "robosimstudio/engines/genesis/solver.py": "63e737c3a3ecd7d7a7caa03b52985a3105c09dedabbde334ed14819b02997b98",
    "robosimstudio/engines/geometry.py": "bf608c195edb44130bf87b5d4a7768b73b48a63ec40e04a6bffbeddd1bfd1ea0",
    "robosimstudio/engines/host.py": "20539d7caa6993b23c004055697dc7ac35917332100619d9e8cf51c657d8c603",
    "robosimstudio/engines/newton/__init__.py": "60f68712037fabec64c4f7db35bca651612747461b7dd4fb96c9f871e808ef67",
    "robosimstudio/engines/pose.py": "db89806e5808a620176327abeaea0bb1ad437372cb31c744fbee8215478bd9bc",
    "robosimstudio/engines/superdex/__init__.py": "3c9a1800db088f7b0270eeeb3fecc5369b68a0f8f7415b54c2397755cba9bc05",
    "robosimstudio/engines/superdex/bridge.py": "b91666ef9a0edf8e592096ce33921abbfd8859113279e4d3e5eb261e632207a2",
    "robosimstudio/engines/superdex/mirror.py": "ed07c509e3f26e0f50d66b9e68b10f7cf08859c4e434c59bd5659a8dcfccd3e6",
    "robosimstudio/engines/superdex/solver.py": "a8349b40d1dcf22e57c32946336172e5b0cacea82c9e2c60535bdb744aa19b15",
    "robosimstudio/paths.py": "c811d6a2e212fa9bb0d31c4603e9f679b5eeb2d87ee2aab9acdeaabb92f37d30",
    "robosimstudio/record/__init__.py": "d499393b795f3ccda2058cb5748c1486f01ede1718f70acb100f24ffc4a67e0a",
    "robosimstudio/record/capture.py": "15675b704ff0c6786f4b29eaf6c126e8a0ac55f630b1be0c840636ad06af85ab",
    "robosimstudio/record/fleet.py": "8ffd6e382f17dc73814c7484b2e514db206365f66d9107e4e4b37c6e299f75ed",
    "robosimstudio/record/recorder.py": "b6722483922235bc65b415cf1c3bef12d4542b189c642c92b0c62a14b9c0da9c",
    "robosimstudio/record/store.py": "324e32ac57fba7bdfb494367c11baa0c971a5520c508f1dd22fae1c141616ab9",
    "robosimstudio/record/trace.py": "0ba566e5cf4233a7d57f7ee15cd0fc06f69ec7c49137192dfc4572f95709da80",
    "robosimstudio/registry.py": "34d22271b1e5708c1643ad722e8df7f8548360e79e6b6afabd0ce406db8e3194",
    "robosimstudio/robots/__init__.py": "eeeb2d439cb3a9999554eb336fa8679b11a78dfe1a0ff4b02a882717eefe35c5",
    "robosimstudio/robots/embodiments/__init__.py": "6b23472818da8387258454a2c6d4f661ad838802127a7cea616e3b33992fa077",
    "robosimstudio/robots/embodiments/panda.py": "89bd5462dbf693e859f79e9740c670f9a3deff7b91613873399e4e1579b65701",
    "robosimstudio/robots/embodiments/yam_bimanual.py": "dd1920b7acbd8a8f59c43a75f4785c8b01168cd44295a26d359c38c3e2ea66ef",
    "robosimstudio/robots/embodiments/yam_i2rt.py": "34d79c4f1d9e937e2e396bcc3d00941589d37af2db759901177735173901c98b",
    "robosimstudio/robots/embodiments/yam_i2rt_arena.py": "0bc660785d11b209714085641a0fe8b493543ac99fc53731bb6807c2f0510039",
    "robosimstudio/robots/embodiments/yam_look.py": "2039100a5b0c8956fd6606909c23adab3d07139782f98df9b340c07fadf60fc3",
    "robosimstudio/robots/entity.py": "23b9b69ccbae16ec7c6a3fad5dd6f6a46e8ce3a0332b39fb6f4e9d5f9f81cf19",
    "robosimstudio/robots/grippers/__init__.py": "472076b55ce7a3a772491031a038326001a1b8abc0f6a925b4c2e13d02c94b66",
    "robosimstudio/robots/grippers/franka_hand.py": "afeaf5183c9d4ec2980aa6a6e7240097f669a83fd938e282ce930fbbe3eabdfb",
    "robosimstudio/robots/grippers/linear_4310.py": "c9d2f333df5078d8f0683713624be184bd7292aed3e2ad45fa195fc4f08570d8",
    "robosimstudio/robots/grippers/robotiq_2f85_menagerie.py": "7df65495ade09d7e7b6f5cbbef711fccae3de132108664aee020bfba01c19c19",
    "robosimstudio/robots/grippers/robotiq_2f85_panda.py": "3b28e8c22f1213dbe4fbf8892f198f87ba1db3ea85b7387c078eaeffabcd1dc7",
    "robosimstudio/robots/grippers/yam_linear_arena.py": "bb3aee9c3822ead26e4b42f4e4f7ebdada0ccd386ea467ae32722620ed4b317f",
    "robosimstudio/robots/registry.py": "311fe4fd873460318fe5911f77de06d6c7f36e549502dcdcbcac71dc96ee51d4",
    "robosimstudio/robots/teleop/__init__.py": "c022e97d3fb8b67f5e6239f17ac69aef1abe5fdbe7f5a30f6d97c03d1ea8d0f7",
    "robosimstudio/robots/teleop/follower.py": "5efdeb4379e035dc972eed8765b05893062dbd6b45ffcb9df015f68f36d1df5b",
    "robosimstudio/robots/teleop/force_feedback.py": "cfa92448a8d2aea0a95681c70663519936f7fb9a77dc9fd4230a9b7dbab40ced",
    "robosimstudio/robots/teleop/lerobot_controller.py": "f96b849680291980a86f8513913d6702b26802219a155525fe5eca1ad05d4689",
    "robosimstudio/robots/teleop/simulated.py": "5b40a137939dbd44ec02d6b53700534423228769f2e29401759a75950909db75",
    "robosimstudio/roots.py": "8a9a5f3c17218ae7441ff45254e686ec7b3e4ba9580f208016b55819f242d54b",
    "robosimstudio/scene/__init__.py": "459a12838ef5db94e8bdfb7efd7466fe1cdf6b7295271b9d369dcb6988841dc3",
    "robosimstudio/scene/assets.py": "ad759558388183e81a5b8107d356298bf49348d609dd61115032bca832036049",
    "robosimstudio/scene/build/__init__.py": "b055ecd040c5bda1ff9746b55bbc646226bc11ecf393f95e63ff678e90f322a7",
    "robosimstudio/scene/build/bodies.py": "b57fca4bfef741a2faddfaea0f40c945e5eb41e1df50e908bfe7feebc40dcbfe",
    "robosimstudio/scene/build/colliders.py": "2da06a3def719af42508318c6dd4e6e53a525263d18e563d09b28f9523cd246c",
    "robosimstudio/scene/build/imports.py": "6f131c2f6780007c5a860d0c68ec3e7e0d69677ab074e5b0e67e74bac5115b40",
    "robosimstudio/scene/builtin/__init__.py": "e87018c1127a25af179b3c93ee2fc2448c139e8cac8dbbf1dd5f5c69df46c6d9",
    "robosimstudio/scene/builtin/benches.py": "1ac46d9564ac0c69e181ab1c742e1362a378f0f525b7649ff5ede177fcc2ee08",
    "robosimstudio/scene/builtin/void.py": "83601b74bd01309f9d59004d1c2b93895f52c0eea8e32bba922a1bd0fae239cd",
    "robosimstudio/scene/compiler.py": "1d53b6c9acf98827e409c1b175a30af31bbcdcda6864f1f6d5ac3ecf02adb39d",
    "robosimstudio/scene/entity.py": "3bd3ca04ccdd65e5177b800d7f58efc3f658638edbcfb602709a3ae50035ca22",
    "robosimstudio/scene/frames.py": "079647b270b1299686073d6713bf9a5b4a1a90b527b2ef497922b41a2a9b8e68",
    "robosimstudio/scene/handles.py": "1d11649a79fce4dcec3d7f956526e4ab5cbe456a1de63d6a0bcbf72f8ffb1f29",
    "robosimstudio/scene/ik_model.py": "1acb0282c5f0242ce603811db0893326a38b7b368972141a6474cdc8b8901387",
    "robosimstudio/scene/parking.py": "e7428414528d6b163ddc962aff301844aeaf4c4a507175639baef5b9a276796b",
    "robosimstudio/scene/physics/__init__.py": "dcf258f37aacb28b45ea236f8cf9ed1b67b8c534f79a15e2ab8cbef8aafd8003",
    "robosimstudio/scene/physics/backends.py": "b1c9bb102f8062e56f07002fcb3d5fc8f0def06b23db9a4dfbde8c143c3d4b6d",
    "robosimstudio/scene/physics/compose.py": "4fca0da88a77f6f21472fce465ba925656335b3fddac5d883df3e98ecd26fd55",
    "robosimstudio/scene/physics/couplers.py": "43460c54677b14267dbae1f58f2314667436faa7767bc2cb07f1f79dcc9ea1b6",
    "robosimstudio/scene/physics/errors.py": "85522c12c8b00e52288de245d7ef0210ddb9911b7fb11210dc4e9483d363ab82",
    "robosimstudio/scene/physics/interactions.py": "3f86e5d85f8365f493eeb98fe94a952b8ff12908c578c409148d54befb44bb89",
    "robosimstudio/scene/physics/islands.py": "de79dd54d13df901d9618d812fb6db6431770dd3c24c4411e9533ee5a58424e1",
    "robosimstudio/scene/physics/kinematic.py": "d5c2cb966a31f999c5706721ec94e4bd12bb8abcc87e586db3304a7623963bdd",
    "robosimstudio/scene/physics/routing.py": "b07f5b21a13784932f890ee0594ec5e974e436ef8f04e19afb67ad7a30461cf2",
    "robosimstudio/scene/physics/world.py": "5e905a45bd4c8ba33975518a4b57b093cb84bd6368d74290b3dd0b54b76464d0",
    "robosimstudio/scene/ref.py": "94fb5d3dae05322ac343152c3aa8bc6561fee882c242e31f3f802b6a2848cc47",
    "robosimstudio/scene/registry.py": "dfd60e05decab93bf7384c836b397ae2822efadd15dc28bea7f18338a9cc2fad",
    "robosimstudio/scene/request.py": "fbc59e9be37dde586057006c29ab00d3a8ccf36077e7672905ca83d6a28137dd",
    "robosimstudio/scene/snapshot.py": "12f1275f96b3a08eba2b69d275daa795fc9ee917e59bd08bd5526085f1a4565d",
    "robosimstudio/scene/state.py": "e3f58f689f13bde36ea750a6a21639f5355c7aaf59d832935dd4fe1dffdc7fa4",
    "robosimstudio/scene/tuning.py": "6352d75fd08d6b531de67b34efd608fe885f0d788e8b94d22d10c02fa7c46814",
    "robosimstudio/sim/__init__.py": "1dc80a7e466bf2e67ee9a2d194745bf6c39b44464a1a7078f24f48c0df0e67df",
    "robosimstudio/sim/draw.py": "d70275689006caa7f0a676ceda0e1c21b8ff5dcecbbc80c6cc284fcb52898a94",
    "robosimstudio/sim/scene.py": "9f0a88b5a3748a75a5433ddb6e28314fa61098583f2a4ba833ec2266bc3f8fb5",
    "robosimstudio/sim/sim.py": "25522328112bec60981edcf9b60056ce6166c60fbef19b282f68065d0f970fd1",
    "robosimstudio/solvers/__init__.py": "2ede3b02cda4dfa48c6f5b696098ce71993baba22c5534b58edba96587998d9a",
    "robosimstudio/solvers/control/__init__.py": "6bd7a5d4ca72a726827392f4d74d75200d7e385ad7aea91c7d0199df627e8629",
    "robosimstudio/solvers/control/action.py": "a9172653f050f672ce45d94f025d6d6f5fcd0380d9838c94596fec599b24a488",
    "robosimstudio/solvers/control/batched.py": "fe20a6ba76a8b1edd7fb77882bf7566e8a5cec811523963980726fd833abdf68",
    "robosimstudio/solvers/grasp/__init__.py": "c0ddc4c567530b1acdea4d02ea5728ffaddef95622c3f0c1a5bace92eb1313fb",
    "robosimstudio/solvers/grasp/antipodal.py": "c670431b7a8113ebd5489cb22c40ea69acbcb32c7e75670159982645973db000",
    "robosimstudio/solvers/grasp/obb.py": "99690e423e42d91b70c0fe93a0a3618b5e4a38938feda9480dc3395d69b294a3",
    "robosimstudio/solvers/ik/__init__.py": "3252d62eb8aa81e4350e734809015425d250560eb546edf1a6665afd1f835ea9",
    "robosimstudio/solvers/ik/arm.py": "2231b06c0624fefd18ff1373c6dc1defaff2d8575931621342be49707ba8ae79",
    "robosimstudio/solvers/ik/arm_ik.py": "e0cf8709274cf10e8b4b53d3103f1ce1b7a5c19e87c0251d2b483d164381cd0f",
    "robosimstudio/solvers/ik/batched.py": "eaf101cd09b54bafd5de1b4e28da29fe353fe61b69a38ad4f1a3804719a337b1",
    "robosimstudio/solvers/ik/dls.py": "8859776df7932a6a3c615803134b7f66368608ae69a33646aff9e09f7ef96e4b",
    "robosimstudio/solvers/ik/fleet_dls.py": "f964bef7417dbb42ecbab712d0e008932038a58716aa7fec3ccc5064abe822f4",
    "robosimstudio/solvers/ik/fleet_fk.py": "ef611cbdb0e40652c67310cae4b3ef6db3ddbb5026f4ea47b02f567ed6d2d2b2",
    "robosimstudio/solvers/ik/pyroki.py": "4f5a66555f2996b36c9ca4b2b9c561941fe8e1d3fe7ca2ddeed48c468562fcd1",
    "robosimstudio/solvers/ik/solver.py": "6fd402550580dbf1a547dc0f3395bfc3c88e7987cb56e02bc52c954fdc76d7a9",
    "robosimstudio/solvers/ik/tool_frame.py": "434801297bd63c86bae800f567d30a79f252d978b89510a8f490a98171d2e527",
    "robosimstudio/solvers/motion/__init__.py": "9c7ca0f5cebf91c3ee9be6641598b60f25fb329b340f4df60ee762773c88f718",
    "robosimstudio/solvers/motion/gripper.py": "9e9c4701e5deaae31fc95b27347f052af27599c5b7394f94f6320d5f105c7817",
    "robosimstudio/solvers/motion/osc.py": "ad9272b5c876797cea8b4c7ee0390abd601ef521d70ef2b04af076e69ec8cd62",
    "robosimstudio/solvers/motion/path.py": "68d0cf29c3f2044d788d19d55d6b4d398adccdf8106b4d2993d14068ab46112e",
    "robosimstudio/solvers/render/__init__.py": "fdd099e34d9d1b4f4f4b0cbbfca018d5f2f2178905669e5c67d0c8abb617a27d",
    "robosimstudio/solvers/render/rtx.py": "e64e0ad8c5909b76c016ce95ebe1af25dbad64e4378e7d3b3f8bb59b607c704f",
    "robosimstudio/solvers/render/tiled.py": "c4f8644a0833a460b169b6131c146cc2153bd98c4c5f61bacd7ed5169c792e93",
    "robosimstudio/specs/__init__.py": "01f2b64588afbf45503dadb803082370be152311d92fb1fffbea15ba824fef48",
    "robosimstudio/specs/arrangement.py": "16e6976b18979ce34c124cc6be53288eaf3bb881a092451eb680d40eb4859552",
    "robosimstudio/specs/asset.py": "a83c973745dda252adf2ca5c1577476b32a05e582b2ad4530536c66fdc09ca80",
    "robosimstudio/specs/base.py": "6fac948cb920c551452f4b3aa3b91c43bd8e037245fca31ec2a63848ca88b39c",
    "robosimstudio/specs/cell.py": "bdf5862c51e3d5f01dbc763f6bc05174b74bfd1debd492a57825d3fee876ec47",
    "robosimstudio/specs/declare.py": "78e81e2e639b5a4f2f8c786ef7963c6e15221499395623183690d8c0b30afb59",
    "robosimstudio/specs/manifest.py": "225e3e14d6392940e56f6512b99f4b8d70f6d7fe21391b6654b7bbb15111a047",
    "robosimstudio/specs/params.py": "0528d9a1cdd75c2e0031076dd2a34efe055dd371b00756f00166aea73915d19a",
    "robosimstudio/specs/physics.py": "5b3800191d21836781b98fd07f49bace4273b098b6e7adec24323f32c93fbe2d",
    "robosimstudio/specs/registries.py": "03ae1d0337135bb26978d9abdbc3e90a5aad4cbf7f353f3ba9e6f8dc5ddc8e77",
    "robosimstudio/specs/robot.py": "7d2ceac37562cb7deca704cb5790f494ca9118a09f0b1695b4ea5272a66da227",
    "robosimstudio/specs/run.py": "5fdd139954495377bca947083cd2d241c6286e098d7520b0486624ae28092589",
    "robosimstudio/specs/task.py": "311b01fd330dd2786cea4d0c87054aa62406e7d1e932b9237565c06a151ad142"
}

COPY_SOURCES = [Path("LICENSE"), Path("NOTICE"), Path("assets/PROVENANCE.md"), MODEL / "LICENSE", MODEL / "yam_i2rt_arms.xml", MODEL / "yam_i2rt_arm.urdf"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checkout_sha(source: Path) -> str:
    git = source / ".git"
    if git.is_file():
        location = git.read_text().strip()
        if not location.startswith("gitdir: "):
            raise ValueError("Cannot resolve source .git metadata")
        git = (source / location.removeprefix("gitdir: ")).resolve()
    head = (git / "HEAD").read_text().strip()
    if not head.startswith("ref: "):
        return head
    ref = head.removeprefix("ref: ")
    if ref.startswith("/") or ".." in Path(ref).parts:
        raise ValueError("Invalid source Git ref")
    loose = git / ref
    if loose.is_file():
        return loose.read_text().strip()
    for line in (git / "packed-refs").read_text().splitlines():
        if line and not line.startswith(("#", "^")):
            commit, name = line.split(" ", 1)
            if name == ref:
                return commit
    raise ValueError("Cannot read pinned source commit")


def mesh_metadata(path: Path, expected: str) -> dict:
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise ValueError(f"Checksum mismatch: {path.name}")
    if len(data) < 84:
        raise ValueError(f"Invalid binary STL: {path.name}")
    triangles = struct.unpack_from("<I", data, 80)[0]
    if len(data) != 84 + triangles * 50:
        raise ValueError(f"Binary STL byte count does not match triangles: {path.name}")
    minimum, maximum = [math.inf] * 3, [-math.inf] * 3
    for triangle in struct.iter_unpack("<12fH", data[84:]):
        for start in (3, 6, 9):
            for axis, value in enumerate(triangle[start:start + 3]):
                if not math.isfinite(value):
                    raise ValueError(f"Non-finite STL coordinate: {path.name}")
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
    return {"file": path.name, "bytes": len(data), "sha256": actual, "triangles": triangles,
            "bounds_original_units": {"min": minimum, "max": maximum}, "units": "metres (upstream MJCF convention)",
            "source_path": str(MODEL / "assets" / path.name), "modified": False}


def right_arm_origins(xml_path: Path) -> list[dict]:
    root = ET.parse(xml_path).getroot()
    body = root.find("./worldbody/body[@name='right_base']")
    if body is None:
        raise ValueError("Pinned MJCF has no right_base body")
    records = []
    def visit(node, parent):
        geom = node.find("geom[@type='mesh']")
        if geom is not None:
            records.append({"body": node.attrib["name"], "parent": parent,
                "body_pos_m": node.get("pos", "0 0 0"), "body_quat_wxyz": node.get("quat", "1 0 0 0"),
                "mesh": geom.attrib["mesh"], "geom_pos_m": geom.get("pos", "0 0 0"),
                "geom_quat_wxyz": geom.get("quat", "1 0 0 0"), "upstream_rgba": geom.get("rgba")})
        for child in node.findall("body"):
            visit(child, node.attrib["name"])
    visit(body, None)
    if len(records) != 9:
        raise ValueError("Expected exactly nine right-arm visual mesh origins")
    return records


def import_runtime(source: Path, vendor: Path) -> None:
    # Fixed relative names, fixed hashes, Python text only. No setup/build/import
    # from the upstream package is invoked while vendoring its source.
    for relative, expected in RUNTIME_EXPECTED.items():
        candidate = source / relative
        if candidate.is_symlink() or sha256(candidate) != expected:
            raise ValueError(f"Pinned runtime source checksum mismatch: {relative}")
    for relative in RUNTIME_EXPECTED:
        target = vendor / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    manifest = {"schema_version": "1.0", "upstream_repository": UPSTREAM_URL,
        "upstream_commit": UPSTREAM_SHA, "license": "Apache-2.0, Copyright 2026 Kaiyuan Chen",
        "scope": "Unmodified core robosimstudio Python package only; no installer, skills, instructions, tests or media",
        "source_modified": False, "file_count": len(RUNTIME_EXPECTED),
        "total_bytes": sum((vendor / relative).stat().st_size for relative in RUNTIME_EXPECTED),
        "files": RUNTIME_EXPECTED}
    (vendor / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify_runtime(vendor: Path) -> dict | None:
    path = vendor / "runtime-manifest.json"
    if not path.is_file():
        return None
    manifest = json.loads(path.read_text())
    if manifest["upstream_commit"] != UPSTREAM_SHA or manifest["files"] != RUNTIME_EXPECTED:
        raise ValueError("Runtime manifest does not match the pinned core allowlist")
    actual_paths = {str(p.relative_to(vendor)) for p in (vendor / "robosimstudio").rglob("*.py") if "__pycache__" not in p.parts}
    if actual_paths != set(RUNTIME_EXPECTED):
        raise ValueError("Vendored Python core file set differs from the pinned allowlist")
    for relative, expected in RUNTIME_EXPECTED.items():
        if sha256(vendor / relative) != expected:
            raise ValueError(f"Vendored runtime source checksum mismatch: {relative}")
    total = sum((vendor / relative).stat().st_size for relative in RUNTIME_EXPECTED)
    if total != manifest["total_bytes"] or len(RUNTIME_EXPECTED) != manifest["file_count"]:
        raise ValueError("Runtime byte or file count differs from its manifest")
    return {"verified_python_files": len(RUNTIME_EXPECTED), "total_bytes": total, "source_modified": False}


def verify(project: Path) -> dict:
    public = project / "public/robots/yam_i2rt"
    vendor = project / "third_party/robosimstudio"
    manifest = json.loads((public / "manifest.json").read_text())
    if manifest["upstream_commit"] != UPSTREAM_SHA or len(manifest["assets"]) != 9:
        raise ValueError("Manifest commit or asset count mismatch")
    recorded = {entry["file"]: entry for entry in manifest["assets"]}
    total = 0
    for name, checksum in EXPECTED.items():
        actual = mesh_metadata(public / name, checksum)
        if mesh_metadata(vendor / MODEL / "assets" / name, checksum) != actual:
            raise ValueError(f"Native/public geometry differs: {name}")
        if actual != recorded[name]:
            raise ValueError(f"Mesh metadata drift: {name}")
        total += actual["bytes"]
    for entry in manifest["source_documents"]:
        if sha256(vendor / entry["path"]) != entry["sha256"]:
            raise ValueError(f"Source document checksum mismatch: {entry['path']}")
    if right_arm_origins(vendor / MODEL / "yam_i2rt_arms.xml") != manifest["right_arm_visual_origins"]:
        raise ValueError("MJCF origin record drift")
    if (public / "LICENSE").read_bytes() != (vendor / MODEL / "LICENSE").read_bytes():
        raise ValueError("Public mesh licence differs from source licence")
    return {"verified_assets": 9, "total_bytes": total, "upstream_commit": UPSTREAM_SHA,
            "geometry_modified": False, "right_arm_visual_origins": 9, "runtime": verify_runtime(vendor)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Pinned RoboSimStudio checkout (read only)")
    parser.add_argument("--verify", action="store_true", help="Verify existing imported files without copying")
    parser.add_argument("--include-runtime", action="store_true", help="Also copy the pinned unmodified core Python package; executes no upstream code")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    public = project / "public/robots/yam_i2rt"
    vendor = project / "third_party/robosimstudio"
    if not args.verify:
        if not args.source:
            parser.error("Pass --source PATH to import, or --verify to check existing assets")
        source = args.source.resolve()
        if checkout_sha(source) != UPSTREAM_SHA:
            raise ValueError(f"Source checkout must be pinned to {UPSTREAM_SHA}")
        # Validate all input mesh bytes before writing any asset.
        assets = [mesh_metadata(source / MODEL / "assets" / name, checksum) for name, checksum in EXPECTED.items()]
        origins = right_arm_origins(source / MODEL / "yam_i2rt_arms.xml")
        public.mkdir(parents=True, exist_ok=True)
        vendor.mkdir(parents=True, exist_ok=True)
        for relative in COPY_SOURCES:
            target = vendor / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
        (vendor / MODEL / "assets").mkdir(parents=True, exist_ok=True)
        for name in EXPECTED:
            shutil.copyfile(source / MODEL / "assets" / name, public / name)
            shutil.copyfile(source / MODEL / "assets" / name, vendor / MODEL / "assets" / name)
        shutil.copyfile(source / MODEL / "LICENSE", public / "LICENSE")
        manifest = {"schema_version": "1.0", "upstream_repository": UPSTREAM_URL,
            "upstream_commit": UPSTREAM_SHA, "upstream_model_origin": "i2rt-robotics/i2rt @ c40b4125 (as recorded in RoboSimStudio assets/PROVENANCE.md)",
            "asset_license": "MIT, Copyright (c) I2RT Robotics", "upstream_project_license": "Apache-2.0, Copyright 2026 Kaiyuan Chen",
            "presentation_change": "FAULTLINE overrides materials to white/graphite; mesh vertices, units and source files are unchanged",
            "transforms": "Backend mesh_poses contain world-space position and xyzw quaternion INCLUDING the MJCF mesh geom-local transform. The browser must not apply geom offsets again.",
            "assets": assets, "right_arm_visual_origins": origins,
            "source_documents": [{"path": str(relative), "sha256": sha256(source / relative)} for relative in COPY_SOURCES]}
        (public / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (vendor / "asset-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if args.include_runtime:
            import_runtime(source, vendor)
        (vendor / "PROVENANCE.md").write_text(f"""# FAULTLINE RoboSimStudio asset import\n\nUpstream: {UPSTREAM_URL}\n\nPinned commit: `{UPSTREAM_SHA}`. The imported nine STL files are byte-identical copies of `assets/embodiments/yam_i2rt/assets/`. Their geometry and units were not changed. A second byte-identical copy sits beside the original MJCF in `third_party/robosimstudio/assets/embodiments/yam_i2rt/assets/`, so native `meshdir="assets"` resolves locally without model rewrites or external symlinks. The original right-arm MJCF and kinematics URDF are retained under their source paths here. Exact checksums, byte sizes, triangle counts and visual origins are in `asset-manifest.json` and `public/robots/yam_i2rt/manifest.json`.\n\nThe YAM arm and linear_4310 gripper models are MIT licensed, Copyright (c) I2RT Robotics. The local model `LICENSE` and public asset `LICENSE` preserve that notice. RoboSimStudio itself is Apache-2.0, Copyright 2026 Kaiyuan Chen; its root `LICENSE`, `NOTICE`, and full `assets/PROVENANCE.md` are copied unchanged. No unimported third-party mesh is claimed or loaded.\n\nFAULTLINE presents the imported geometry with a white/graphite material override; original mesh vertices and model origins are preserved. The backend supplies each mesh's authoritative world pose, including the MJCF geom-local transform. Rendering does not solve IK, animate joints independently, or load upstream simulation code. Rendering the meshes alone does not imply execution of the RoboSimStudio Newton/Warp physics runtime.\n\nAn optional runtime-source import copies exactly the 198 core Python files listed and hashed in `runtime-manifest.json`, unchanged at the same pinned commit. It does not copy upstream AGENTS/CLAUDE instructions, skills, tests, media, installers or bytecode caches. Dependencies and real CPU execution are handled separately by the local worker; the existence of vendored source is not a claim of successful physics execution. The core package remains covered by the copied Apache-2.0 licence and NOTICE.\n\nReproduce from a checkout at the pinned commit:\n\n```sh\npython3 scripts/import_robosim_assets.py --source /path/to/robosimstudio\npython3 scripts/import_robosim_assets.py --source /path/to/robosimstudio --include-runtime\npython3 scripts/import_robosim_assets.py --verify\n```\n\nThe importer reads XML and copies a fixed file allowlist; it executes no upstream program.\n""")
    print(json.dumps(verify(project), indent=2))


if __name__ == "__main__":
    main()
