// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PoseidonPallas
/// @notice Mina's Poseidon hash over the Pallas base field (kimchi parameters).
///
/// @dev Parameters: state width 3, rate 2, 55 full rounds, S-box x^7, no
/// partial rounds. These are Mina's kimchi parameters, and the round constants
/// and MDS matrix below are taken verbatim from the reference implementation in
/// youtpout/pallas_curve_verifier, which is itself derived from o1js.
///
/// **Why the constants live in bytecode.** The reference implementation stores
/// them in a `uint256[3][55]` storage array and reads each one with `SLOAD`.
/// That is 165 cold SLOADs at 2100 gas — roughly 346,000 gas per permutation,
/// which dominates the entire hash. Here the same 5,280 bytes sit in contract
/// code and are copied into memory once with a single `CODECOPY`, costing on
/// the order of a thousand gas. Every subsequent access is an `MLOAD` at 3 gas.
///
/// This is the single largest saving available in the verifier, and it is worth
/// more than every elliptic-curve optimisation combined.
library PoseidonPallas {
    uint256 internal constant P =
        28948022309329048855892746252171976963363056481941560715954676764349967630337;

    uint256 internal constant FULL_ROUNDS = 55;
    uint256 internal constant RATE = 2;
    uint256 internal constant WIDTH = 3;

    uint256 internal constant MDS_00 = 12035446894107573964500871153637039653510326950134440362813193268448863222019;
    uint256 internal constant MDS_01 = 25461374787957152039031444204194007219326765802730624564074257060397341542093;
    uint256 internal constant MDS_02 = 27667907157110496066452777015908813333407980290333709698851344970789663080149;
    uint256 internal constant MDS_10 = 4491931056866994439025447213644536587424785196363427220456343191847333476930;
    uint256 internal constant MDS_11 = 14743631939509747387607291926699970421064627808101543132147270746750887019919;
    uint256 internal constant MDS_12 = 9448400033389617131295304336481030167723486090288313334230651810071857784477;
    uint256 internal constant MDS_20 = 10525578725509990281643336361904863911009900817790387635342941550657754064843;
    uint256 internal constant MDS_21 = 27437632000253211280915908546961303399777448677029255413769125486614773776695;
    uint256 internal constant MDS_22 = 27566319851776897085443681456689352477426926500749993803132851225169606086988;

    /// @notice 55 rounds x 3 constants, big-endian, 32 bytes each.
    bytes internal constant ROUND_CONSTANTS =
        hex"2ec559cd1a1f2f6889fc8ae5f07757f202b364429677c8ff6603fd6d93659b47"
        hex"2553b08c788551bfe064d91c17eb1edb8662283229757711b2b30895f0aa3bad"
        hex"25a706fb0f35b260b6f28d61e082d36a8f161be1f4d9416371a7b65f2bfafe4e"
        hex"37c0281fda664cc2448d0e7dd77aaa04752250817a945abeea8cfaaf3ee39ba0"
        hex"140488321291998b8582eaceeb3fa9ca3980eb64a453573c5aaa2910405936b6"
        hex"3a73fe35b1bdd66b809aad5eab47b5c83b0146fd7fc632dfb49cd91ae1169378"
        hex"21b7c2b35fd7710b06245711f26c0635d3e21de4db10dd3a7369f59f468d7be6"
        hex"1803a068d25fef2ef652c8a4847aa18a29d1885e7bf77fd6a34d66536d09cad7"
        hex"291de61c5e6268213772cf7e03c80c2e833eb77c58c46548d158a70fbbd9724b"
        hex"230043a0dc2dfab63607cbe1b9c482fdd937fdefecc6905aa5012e89babead13"
        hex"218af77a05c502d3fa3144efcf47a0f2a0292498c10c6e2368565674e78764f4"
        hex"223e2d94c177d27e071d55729d13a9b216955c7102cc9a95ea40058efb506117"
        hex"2a18257c15ad9b6fe8b7c5ad2129394e902c3c3802e738f24ce2f585ae5f6a38"
        hex"0a6f7ba75f216403d2e4940469d199474a65aa5ef814e36400bddef06158dcf8"
        hex"169be41c6227956efef5b4cdde65d00d5e04fe766178bdc731615c6e5b93e31e"
        hex"2e28f50a9a55d2e91774083072734544417e290a1cfebc01801b94d0728fe663"
        hex"0fdedf8da8654a22831040cfc74432464b173ee68628fd90498480b9902f2819"
        hex"046a3ed9863d2d739dd8bc9e90a746fda1197162d0a0bec3db1f2f6042cf04e2"
        hex"219e08b460c305b428670bacab86ac1e9458075778d35c3619ae7ba1f9b2ed76"
        hex"38bb36a12ebcec4d4e8728eb43e3f12a6e33b1ffa1463379018d4e12424e62ca"
        hex"1e9aa3fe25d116ccfbd6a8fccdae0aa9bc164a03ab7e951704ee9a715fbedee6"
        hex"030f33ed70da4c2bfb844ff1a7558b817d1ec300da86a1694f2db45047d5f18b"
        hex"0282b04137350495ab417cf2c47389bf681c39f6c22d9e370b7af75cbcbe4bb1"
        hex"09b1528dea2eb5bd96905b88ff05fdf3e0f220fe1d93d1b54953ac98fec825f0"
        hex"30083dbbb5eab39311c7a8bfd5e55567fa864b3468b5f9200e529cda03d9ef71"
        hex"017eace73cf67c6112239cbf51dec0e714ee4e5a91dbc9209dc17bbea5bcd094"
        hex"37af1de8f5475ba165b90f8d568683d54e215df97e9287943370cf4118428097"
        hex"16ff7592836a45340ec6f2b0f122736d03f0bcb84012f922a4baa73ea0e66f51"
        hex"1a5985d4b359d03de60b2edabb1853f476915febc0e40f83a2d1d0084efc3fd9"
        hex"255a9d4beb9b5ea18ab9782b1abb267fc5b773b98ab655fd4d469698e1e1f975"
        hex"34a8d9f45200a9ac28021712be81e905967bac580a0b9ee57bc4231f5ecb936a"
        hex"0979556cb3edcbe4f33edd2094f1443b4b4ec6c457b0425b8463e788b9a2dcda"
        hex"2a4d028c09ad39c30666b78b45cfadd5279f6239379c689a727f626679272654"
        hex"0c31b68f6850b3bd71fe4e89984e2c87415523fb54f24ec8ae71430370154b33"
        hex"1a27ca0b953d3dba6b8e01cf07d76c611a211d139f2dff5ac023ed2454f2ed90"
        hex"109ae97c25d60242b86d7169196d2212f268b952dfd95a3937916b9905303180"
        hex"3698c932f2a16f7bb9abac089ec2de79c9965881708878683caf53caa83ad9c4"
        hex"3c7e25e0ac8fba3dc1360f8a9a9fa0be0e031c8c76a93497b7cac7ed32ade6c0"
        hex"2fc5023c5e4aed5aa7dfca0f5492f1b6efab3099360ec960237512f48c858a79"
        hex"2c124735f3f924546fb4fdfa2a018e03f53063d3a2e87fd285ba8d647eda6765"
        hex"12c875c9b79591acf9033f8b6c1e357126c44b23f3486fbee0d98340a3382251"
        hex"3cda935e895857d39a7db8476aeda5a5131cb165a353073fd3e473fd8855528d"
        hex"218eb756fa5f1df9f1eb922ef80b0852588779a7368e3d010def1512815d8759"
        hex"23bcf1032957015ef171fbb4329bca0c57d59885522f25f4b082a3cf301cfbc6"
        hex"17474c3b6a9bc1057df64b9e4d62badbc7f3867b3dd757c71c1f656205d7bceb"
        hex"019826c0ee22972deb41745d3bd412c2ae3d4c18535f4b60c9e870edffa3d550"
        hex"30bcb17dfd622c46f3275f698319b68d8816bed0368ded435ed61992bc43efa9"
        hex"3bd816c214c66410229cfbd1f4a3a42e6a0f82f3c0d49b09bc7b4c042ff2c94b"
        hex"08943ec01d9fb9f43c840757738979b146c3b6d1982280e92a52e8d045633ea1"
        hex"2670bf8c01822e31c70976269d89ed58bc79ad2f9d1e3145df890bf898b57e47"
        hex"0dd53b41599ae78dbd3e689b65ebcca493effa94ed765eeec75a0d3bb20407f9"
        hex"068177d293585e0b8c8e76a8a565c8689a1d88e6a9afa79220bb0a2253f203c3"
        hex"35216f471043866edc324ad8d8cf0cc792fe7a10bf874b1eeac67b451d6b2cf5"
        hex"1fd6efb2536bfe11ec3736e7f7448c01eb2a5a9041bbf84631cc83ee0464f6af"
        hex"2c982c7352102289fc1b48dafcd9e3cc364d5a4324575e4721daf0af10033c67"
        hex"352f7e8c7662d86db9c722d4d07778858771b832af5bb5dc3b13cf94851c1b45"
        hex"18e3c0c1caa5e3ed66ee1ab6f55a5c8063d8c9b034ae47db43435147149e37d5"
        hex"3124b12deb37dcbb3d96c1a08d507523e30e03e0919559bf2daaab238422eade"
        hex"143bf0def31437eb21095200d2d406e6e5727833683d9740b9bfc1713215dc9a"
        hex"1ebee92143f32b4f9d9a90ad62b8483c977480767b53c71f6bde934a8ef38f17"
        hex"0ff6c794ad1afaa494088d5f8ee6c47bf9e83013478628cf9f41f2e81383ebeb"
        hex"3d0a10ac3ee707c62e8bdf2cdb49ac2cf4096cf41a7f214fdd1f8f9a24804f17"
        hex"1d61014cd3ef0d87d037c56bdfa370a73352b95d472ead1937bed06a31801c91"
        hex"123e185b2ec7f072507ac1e4e743589bb25c8fdb468e329e7de169875f90c525"
        hex"30b780c0c1cb0609623732824c75017da9799bdc7e08b527bae7f409ebdbecf2"
        hex"1dfb3801b7ae4e209f68195612965c6e37a2ed5cf1eeee3d46edf655d6f5afef"
        hex"2fdee42805b2774064e963c741552556019a9611928dda728b78311e1f049528"
        hex"31b2b65c431212ed36fdda5358d90cd9cb51c9f493bff71cdc75654547e4a22b"
        hex"1e3ca033d8413b688db7a543e62ac2e69644c0614801379cfe62fa220319e0ef"
        hex"0c8ef1168425028c52a32d93f9313153e52e9cf15e5ec2b4ca09d01730dad432"
        hex"378c73373a36a5ed94a34f75e5de7a7a6187ea301380ecfb6f1a22cf8552638e"
        hex"3218aeec20048a564015e8f221657fbe489ba404d7f5f15b829c7a75a85c2f44"
        hex"3312ef7cbbad31430f20f30931b070379c77119c1825c6560cd2c82cf767794e"
        hex"356449a71383674c607fa31ded8c0c0d2d20fb45c36698d258cecd982dba478c"
        hex"0cc88d1c91481d5321174e55b49b2485682c87fac2adb332167a20bcb57db359"
        hex"1defccbd33740803ad284bc48ab959f349b94e18d773c6c0c58a4b9390cc300f"
        hex"2d263cc2e9af126d768d9e1d2bf2cbf32063be831cb1548ffd716bc3ee7034fe"
        hex"111e314db6fb1a28e241028ce3d347c52558a33b6b11285a97fffa1b479e969d"
        hex"027409401e92001d434cba2868e9e371703199c2372d23ef329e537b513f453e"
        hex"24a852bdf9cb2a8fedd5e85a59867d4916b8a57bdd5f84e1047d410770ffffa0"
        hex"205d1b0ee359f621845ac64ff7e383a3eb81e03d2a2966557746d21b47329d6e"
        hex"25c327e2cc93ec6f0f23b5e41c931bfbbe4c12da7d55a2b1c91c79db982df903"
        hex"39df3e22d22b09b4265da50ef175909ce79e8f0b9599dff01cf80e70884982b9"
        hex"09b08d58853d8ac908c5b14e5eb8611b45f40faaa59cb8dff98fb30efcdfaa01"
        hex"1ece62374d79e717db4a68f9cddaaf52f8884f397375c0f3c5c1dbaa9c57a0a6"
        hex"3bd089b727a0ee08e263fa5e35b618db87d7bcce03441475e3fd49639b9fa1c1"
        hex"3fedea75f37ad9cfc94c95141bfb4719ee9b32b874b93dcfc0cc12f51a7b2aff"
        hex"36dfa18a9ba1b194228494a8acaf0668cb43aca9d4e0a251b20ec3424d0e65cd"
        hex"119e98db3f49cd7fcb3b0632567d9ccaa5498b0d411a1437f57c658f41931d0c"
        hex"1100b21c306475d816b3efcd75c3ae135c54ad3cc56ca22abd9b7f45e6d02c19"
        hex"15791f9bbea213937208c82794eb667f157f003c65b64aa9800f4bbee4ea5119"
        hex"1adbeb5e9c4d515ecfd250ebee56a2a816eb3e3dc8d5d440c1ab4285b350be64"
        hex"1fbf4738844a9a249aec253e8e4260e4ab09e26bea29ab0020bf0e813ceecbc3"
        hex"3418a929556ec51a086459bb9e63a821d407388cce83949b9af3e3b0434eaf0e"
        hex"09406b5c3af0290f997405d0c51be69544afb240d48eeab1736cda0432e8ff9e"
        hex"23ece5d70b38ccc9d43cd923e5e3e2f62d1d873c9141ef01f89b6de1336f5bc7"
        hex"1852d574e46d370a0b1e64f6c41eeb8d40cf96c524a62965661f2ef87e67234d"
        hex"0a657027cce8d4f238ea896dde273b7537b508674a366c66b3789d9828b0ce90"
        hex"3482f98a46ec358108fbbb68fd94f8f2baa73c723baf21922a850e45511f5a2d"
        hex"3f62f164f8c905b335a6cbf76131d2430237e17ad6abc76d2a6329c1ec5463ee"
        hex"07e397f503f9c1cea028465b2950ea444b15c5eab567d5a69ea2925685694df0"
        hex"0405f1fc711872373d6eb50a09fbfb05b2703ae0a0b4edb86aedb216db17a876"
        hex"0be0848eb3e09c7027110ad842c502441c97afa14a844406fcfec754a25658c1"
        hex"26b78788fd98ac020bac92d0e7792bb5ffed06b697d847f61d984f905d9ba870"
        hex"38fd5318d39055c82fef9bdd33315a541c0ec4363e6cc0687005871355dfa573"
        hex"380bd03b840c48c8ba3830e7cace72f91a5002218c617294e8c8bc687d5216de"
        hex"2c6e57ddc1d7c81a0299ed49c3d74759416bc8426f30e2af5622895c531b4e1c"
        hex"11d3a81b262fc76ef506ee6d88e5991d0de8cb9dd162d97c58b175e3bc4584f3"
        hex"09b6b283ebaf45fbb1e448969ace9be62adf67ddf58614925741deb6a1ba7def"
        hex"15d5095164c885763fa83cdf776d436382821a17bc5563a5b6f6dfcdac504ade"
        hex"3427fdbfca3cea23063eb138c5055c6cad9c4252b23d12c12293308eff7d9124"
        hex"272f12e731077b74317ef2543c33b86194db1da5f6a7e1eee0656672c81685fe"
        hex"05323f85deb8c07c193c37a73d76f6114967913a2bdce11995f183e769f42967"
        hex"3d5ce415ecae4ba42b417ea3a501b44694f46efddff2fcca952b097f3852d3d8"
        hex"0e8ec18c7b52c514d42047f1f0b2a90cb8c0c7391cf9479cd7fd5bfe1d3db8f2"
        hex"01591c865ea7065d54304519f8bb268bddbeaf3afae54edcd01a833ed0a9ef1a"
        hex"3eddbeeee5eca5deee4bf1789c435e1241e0d71186d8f0f62d74729dfc3119fb"
        hex"23691c7009b9283b268766e8d491716d3c1993e6ecf458def8f762af3e355707"
        hex"26cdab2c837ebeac5bea4be1d6f0488034907374d81a61a34f1c4db397d4c09b"
        hex"2d2206730664d58be0676dad1fee0e990c264a7410a2cdb6b55653c1df72ef56"
        hex"2bb74bb185372334a4ef5f6d18e2ece54086e62b04985dd794b7117b0be9217f"
        hex"366250fe928c45d8d5aa35f0a142754907ff3c598410199b589b28cd851b2204"
        hex"1868f8118482c6b4a5a61a81c8aaca128953179c20f73a44022d9976bdc34af1"
        hex"0b7901c670e1d75d726eb88d000950b3c963f0f7a6ca24994bdc07ae2f78b4d3"
        hex"032c4bd8ab70e1f25af77af57dd340c8e6c8a101dfc5e8dd03314566db90b870"
        hex"1ce36db31fe6ea3cd9308db9aa43a8af5c41a8f0a6509bfe00f0e7b486c0ab8a"
        hex"26596ea9e1915e53da3479e9d13c3c920505e2449e325810ff6ca855fe4b7c6e"
        hex"30f296a269868a7fca8f5b1e269c0116304df31729559a270e713509d3a6d5dc"
        hex"02588961eff7897d87eb6ac72350ef9f52640647cbd23136919a994dfd1979d5"
        hex"16a49e69721e80690d41e06229e9bc2dbaf9a2abf4b89388db2485595409d62b"
        hex"3d7aca02c051fcad8073cfd67210cd423a31888afc4a444d9d3adf3d6c5da7bf"
        hex"299bd48a740b7790075268312ab8072c72421de5a6437fa5e25431ef951847b4"
        hex"11a69b867d9ea22ec1b2f28e96617129e36eefaea9e8126bdc6a42b99072902b"
        hex"25bc1af391f3c1f2284a95da92b5883d1b3a40794b2358b2e7a70fca22da64ce"
        hex"361ab3843f4d8ddadede39d82bb1a8109f89b6d9aa117b8f365de43895de0baa"
        hex"38ef3ab5b61c117a3465a017a9c8ba4c227659b41fdf145206d5c960f49dd45b"
        hex"3992f83f26143dbdbd335604a1a14daf238ae43c249783f694feaf560aaae20f"
        hex"350287977eb71c81b10ecd039aad99cfa9ed84a04301cb30869e1dc7fa1dc638"
        hex"3afb5bc126020586dcccba32dd054cd9a3f3b834ca9678d6802c48b1da97d6ed"
        hex"172b7c2d8e7e4b06d183a2575b790749d0970c54966407fa8f59072c729de671"
        hex"2eb53fe3a278688a70494569e54a0f0d269935aec6c897bef4d368c1f67d57e4"
        hex"0375ae56b8d9310d553ed77d406dedc3f0393e5a321b71caee6a5bb7078b5035"
        hex"1d49a0d53bc2993cbf1fb5d1da9bb76fe46a7031d5e5d43fadbf54bc17c1ef38"
        hex"132d17b87cab6d707ddfa1f01df1724ad37957e989c44f1ff71426367f953160"
        hex"062da5280948d8c6c4acc7e6a1aa421f0f9ec179a44146750060be4be6755f85"
        hex"0a4b4d5cde54a974ea4e57ee4132d2ab2510c300f21930d6bbbf211d1add80f9"
        hex"3356f1fbeac493ccab752b70bbed821ce49965c19284d7aacd78fbf3ff864e91"
        hex"042721e8a9cc32557851feb0e0190c5dfbf4cb1b8f47d37e7e653ec6ff8a4059"
        hex"053d9b2633fff31ca4fc5724ce6b4422318128cdf01897d321e86f47cdf748b1"
        hex"267d96caeafde5dbd3db1f0668b09ccd532a22f0205494716a786219fb4c801c"
        hex"39316997737610193c3f9ffcfd4e23d38aac12cd7b95b8d256d774101650a6ca"
        hex"191e377462986563fdabf9b23529f7c84c6b200b9101b3a5096bca5f377981fb"
        hex"20f89af9722f79c860d2059a0ec209cf3a7925ad0798cab655eca62fe73ff3d9"
        hex"1ca568aeddb2ef391a7c78ecf104d32d785b9ca145d97e35879df3534a7d1e0b"
        hex"25de9ba0a37472c3b4c0b9c3bc25cbbf78d91881b6f94ee70e4abf090211251c"
        hex"3393debd38d311881c7583bee07e605ef0e55c62f0508ccc2d26518cd568e1ef"
        hex"038df2fd18a8d7563806aa9d994a611f642d5c397388d1dd3e78bc7a4515c5b1"
        hex"05c6503ff1ee548f2435ad9148d7fb94c9222b0908f445537a6667047f6d501c"
        hex"104c88d6d0682d82d3d664826dc9565db101a220aa8f90572eb798468a82a2ab"
        hex"2caad6108c09ee6aee7851b4a2d2d3b7c3ca3c56a80003c8471f90bfa4ac628b"
        hex"0a57dbd4c327826c8a97bc7285f94bcddb966177346f1792c4bd7088aa0353f3"
        hex"3c15552f9124318b8433d01bb53ba04ba1cc9eb91d83b918e32fea39fbe908fa"
        hex"0e10c10cbbe1717a9441c6299c4fc087c222208bd4fa8f3be66d2075f623b513"
        hex"1e8b254cbff2c92a83dff1728c81dd22a9570f590e497cb2d640042cb879a930"
        hex"1812dbcd70c440610057bbfdd0cc4d31d1faf5786419b53841c4adc43f2b2352";

    /// @notice Copy the round constants into memory. One CODECOPY.
    /// @dev Callers hoist this out of any loop; a permutation takes the memory
    /// pointer rather than re-copying.
    function loadConstants() internal pure returns (bytes memory rc) {
        rc = ROUND_CONSTANTS;
    }

    /// @notice x^7 mod P, the S-box. Four multiplications.
    function power7(uint256 x) internal pure returns (uint256) {
        uint256 x2 = mulmod(x, x, P);
        uint256 x4 = mulmod(x2, x2, P);
        uint256 x6 = mulmod(x4, x2, P);
        return mulmod(x6, x, P);
    }

    /// @notice One full permutation of the 3-element state.
    /// @param state The sponge state, mutated in place.
    /// @param rc Round constants in memory, from {loadConstants}.
    function permute(uint256[3] memory state, bytes memory rc) internal pure {
        for (uint256 round = 0; round < FULL_ROUNDS; ++round) {
            uint256 s0 = power7(state[0]);
            uint256 s1 = power7(state[1]);
            uint256 s2 = power7(state[2]);

            uint256 c0;
            uint256 c1;
            uint256 c2;
            assembly {
                let base := add(add(rc, 32), mul(round, 96))
                c0 := mload(base)
                c1 := mload(add(base, 32))
                c2 := mload(add(base, 64))
            }

            state[0] = addmod(
                addmod(
                    addmod(mulmod(MDS_00, s0, P), mulmod(MDS_01, s1, P), P),
                    mulmod(MDS_02, s2, P),
                    P
                ),
                c0,
                P
            );
            state[1] = addmod(
                addmod(
                    addmod(mulmod(MDS_10, s0, P), mulmod(MDS_11, s1, P), P),
                    mulmod(MDS_12, s2, P),
                    P
                ),
                c1,
                P
            );
            state[2] = addmod(
                addmod(
                    addmod(mulmod(MDS_20, s0, P), mulmod(MDS_21, s1, P), P),
                    mulmod(MDS_22, s2, P),
                    P
                ),
                c2,
                P
            );
        }
    }

    /// @notice Absorb `input` into `state`, rate 2, permuting per full block.
    function absorb(uint256[3] memory state, uint256[] memory input, bytes memory rc)
        internal
        pure
    {
        uint256 i;
        while (i < input.length) {
            state[0] = addmod(state[0], input[i], P);
            if (i + 1 < input.length) {
                state[1] = addmod(state[1], input[i + 1], P);
            }
            permute(state, rc);
            unchecked {
                i += RATE;
            }
        }
    }

    /// @notice Hash a field vector with Mina's sponge construction.
    /// @dev Mirrors `mina_hasher`: absorb, then squeeze `state[0]`.
    function hash(uint256[] memory input) internal pure returns (uint256) {
        bytes memory rc = loadConstants();
        uint256[3] memory state = [uint256(0), 0, 0];
        absorb(state, input, rc);
        return state[0];
    }

    /// @notice Domain-separated hash, matching o1js `Poseidon.hashWithPrefix`.
    /// @param prefixField The prefix string packed into a field element.
    /// @param input The fields to hash under that domain.
    ///
    /// @dev The prefix is absorbed **alone** and permuted before `input` is
    /// absorbed. That is not the same as `hash([prefixField, ...input])`: the
    /// sponge has rate 2, so prepending would absorb the prefix in the same
    /// permutation as the first input field and yield a different digest.
    ///
    /// `prefixField` is o1js `prefixToField`: the prefix's UTF-8 bytes,
    /// zero-padded to 32 and read little-endian. Computing it off-chain keeps
    /// the string out of the calldata and the packing out of the gas cost.
    function hashWithPrefix(uint256 prefixField, uint256[] memory input)
        internal
        pure
        returns (uint256)
    {
        bytes memory rc = loadConstants();
        uint256[3] memory state = [prefixField, 0, 0];
        permute(state, rc);
        absorb(state, input, rc);
        return state[0];
    }
}
