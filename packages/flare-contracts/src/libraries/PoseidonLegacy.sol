// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PoseidonLegacy
/// @notice Mina's *legacy* Poseidon, which is what `signMessage` hashes with.
///
/// @dev A second hash, not a variant of the first. `signFields` — what this
/// project uses today — hashes with Kimchi Poseidon: 55 rounds, x^7, 165 round
/// constants. `signMessage` hashes with this one: **63 rounds, x^5, 300 round
/// constants**, a different MDS matrix, an initial round constant, and an input
/// packed from bits rather than field elements.
///
/// It exists to answer one question with a number instead of a guess: what it
/// would cost to verify a signature a wallet can actually display. Auro renders
/// `signFields` as a column of raw decimals nobody can check, and `signMessage`
/// as text — but only this hash makes that signature verifiable on chain.
///
/// Constants live in code and are copied into memory with a single CODECOPY,
/// the same trick as {PoseidonPallas}. At 9600 bytes they are nearly a third of
/// the EIP-170 limit on their own, which is why this is a separate library.
library PoseidonLegacy {
    /// @notice Pallas base field modulus.
    uint256 internal constant P =
        0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001;

    uint256 internal constant FULL_ROUNDS = 63;

    /// @dev Legacy applies a round constant before the first round, unlike
    /// Kimchi. Missing it produces a plausible hash that matches nothing.
    bool internal constant HAS_INITIAL_ROUND_CONSTANT = true;

    /// @notice 100 rounds x 3 elements. Only the first 64 are reached at 63
    /// rounds plus the initial constant; the rest are carried because the
    /// parameter set defines them and a future round count would need them.
    bytes internal constant ROUND_CONSTANTS =
        hex"02f9dadabbc991f8d691dc62fea5f8ae37b76efe5169a9b0cc92a4820ccb53781783bec6c3570a733c43953d9584b229a9737a3629f1d0dab0b78665580b88e528c01df6666b04196cf02af0390756bba8ecfe80106e3f56377ead8957340c7b"
        hex"0cd102badb124ebe9c7358494bd7fa35928b7c0954bbf25f00f95df0a63992b4020f1731eef7b4190a40dacf31757cc39bd16733e18d5f624741757bfd7a51d51e3339ede4ca0304d2fdadf84d097d0bdd370e0aeaa49d68db98fde08cdbdf52"
        hex"0d6f067838fca70a3a82d8f7ed72345b0d88d592e2ed2aa03fdeb28371bdad603fb917be23bf82c2ba391b81704ee5a7aae2a9a7e8a75d4b5678f03b729c756f33c766ac8e43ad4f0001fe8aa2165058d1015a3bed8b2cf657a0d21951ec6995"
        hex"1e6870fd342783ff94d630d4ae7abe1b7c989b533d123fe0290a2fe9afa8b58d31841af166bee119a8ebe61e079a2b962ce00c71e02694847a61118c8634e0da1ce218cbe1cd33d3bd3802dde999d1fb33b3806b1b222d1f488e655616f6d5af"
        hex"333772c14246fd782e07478d2cc23cdd5d9d66103377c00176a8f536b6c1d1aa0425e6a47af44e68352c070ac03c82e97758630e9376e9207e85bcf2bc46192038433342a831c71d9604a5f04595308a32f0ed60c76f3d8fb75fb677a32b6eb6"
        hex"04c793fc2c4db319f2565881f0eefbdede66ef0b0d314f953e873063105432112a5c181209489bf91a447f187729b2f144ceb9b825ef2f8ad979128f18ad105e36e4781a629fcfe8489dbf28f6a7526a7fe5640fbec1b3cf5f155ae760f26f41"
        hex"2348bed14360723e8c643fd1f022ce150fb349e2a5db5f62fbc09705713e554711b371d0f4a9d4dc688ee6b43d5ed6258a137aa16ac4e190f4aea30516d13d5a298d37b85dec2b7d548877975b2de198327e9734bdcdca9a1bd2657121fb8ebb"
        hex"2ae8b1483af5eb5c754ad6a519b214ce67c772ad7537dbd60717492056421f431e3050261e80372fa5830b0a6f119cf3c4e4ddaa8f585310a0c488d850d653bf1f28f3d4242e8dfe21201b6f28daacb1d9159cbdbe2a26e618ca349999de7c5d"
        hex"1d469a8eeeb675773d9e9164c94aeda355681fcacd87bd25fb688d816dd5023438d6ecd101eb008bc3d94b9f840c68f5c911877303f084f0f72a04d51fae0ead3b65f8d1d63bd4c211e9658aeb909873d074df4bf8bb8b11cdbcb92e172657cd"
        hex"34cf76f034657b1fa7c83b6c8aaa9e65466aaee1cad433d7c09a5c7361c891092542cd1460d869400226d2d6c126a4812404cc7e007a73859dddc6fc2e19c1e828c7560c1ec842179268bcf3813f4f4be05fa6e600bbfb6daed5b862358205ed"
        hex"255b3e6138146a37f70cb9f8f4ce44ba6d7eb08f0994a537ea6ff6b84152583f34b63eb174ec334dae32417f5cc272f2171665e32d323f6a58ba7690ac57cc2835e0c2b608547ab67f05ecd61f1aeaeac0139fffe734fa073c33ea087d1e1fbb"
        hex"38115c9f35b03dcc031a30d9bc4b1ff93830d9e1edded022e05d843a2f0347e603494b3eea9bd5533003b3e59a455f353b5ece83e79134033a22580a05685b5c293d819ac238e2333c064a816955cfcbf3d557a817785c513349eb03c721b76e"
        hex"29bcabb23f2d09b8475b951f5ba2bb338dae11940b0557718b63c45e6c1ec9ca00652648b3548800e4c4e9a5be98e2027130f83c2b57e3f1eea2ee042945309012877b538224e235d91d77661f9e0c73d3d67367852769268b6e7933e7539118"
        hex"093c115bb0f28811a7a11c041ef5847f4ec11dd787457ffe9716b2a996da3d6c2434aedf500ce5314cce60f7d540710160341ed7fe8faab2fcd2deef687318291291b3e81b69a2d7eb1b566e4e22a28b2a8aae13dc9b6fd50c14ca47897a905f"
        hex"222013376f6283e3e633f6969ea07641d57e7dee499ac3e881ee4e14d142449909067a146776a12055d073e0328ae1d483a4c00d89cc10d80bdc2d6755f4d8893a40dc2198f80b690ff1679bb0538c75b3d718a0283920ce8d39f12d9cfa27ab"
        hex"1576532889a8dd5dd7bc42845f08f63bacfb53d4081838742b154be87b00b9343db4ef72bd8bd58506ed2e6770520bfc133b53d095eaf820e4668528931de9ec2d1e1687b8b93e398a98051141607f1692c706d702670019ebdd2b72247ad9ba"
        hex"323e9676d56bd57906a49e8f64296b16a5ab57587c1092bd4f3d9fbc48d5bdaa1b8309450bc4500389bfc6f736af1478d3a1eac53dce59473d7e682ed25758af3beb7f00630155ff39e5314babba6ab06ffdaa786b7add69e9895791b9055bb7"
        hex"1fe58500a9141b81fdacedf9fc56a9db74ad3e4b5acf78bf8f01cd70440f3cad32aad1dc3e6fe3bcac504e2c1fd1b1d5d67ccc4453494595ab54eddc3675b96807a380f595acad204ea45f406877315ed504c78044c18c0f867c0e50ca1721cd"
        hex"09fa52f7acb1009c154114747411f2ef0948b5a7b2ba9fc747bffb9766ba85892835d3ee4caa0b46514ec41c9f2196f5fdae2c68c47710a41f6efd68869c376b14e2d97c0abb872d8efe475c9ccbdc09694767919087a59d46b5a226ca29b93a"
        hex"0722e1113d90324e06820ff86dc1280d743f2a8288a18b30b26af75f1333e08620b78ceb6e0df0292c43cde8d53df0bc20c7c7fc6a66fdbd3f54d8dce2ba839632e168964ba20a863fd84d46b44bc82ffc5174ead595f35253bc972b8cd0ee31"
        hex"2e61cd35d9d990f9f871e90b768909d88311739321d846f7af89494f891ba4d32ded160893ae32d074fb0700ec1398918543bf95101c0144604cc4d4539f8b5c16577ae073be82232c35882854222749e9d8e0a8fbbf7081ee9c2b42a9f309e5"
        hex"187e88ba7cccdf4057e20ff2e0177574d8c34711913feebd5dab4f895af005d30a60ab41c11f95fa605f57c10f8d34b800b7d8159e5f7b00a3b2cb5f2091a8462914e18873f7378eb210b493ce3991ac9808a9e9a4d41e104cfc2bacab72b617"
        hex"06c6f01aa8ca190a0e95409a41738505c13006cc008534ab8a68ebf9b71d74e128ef788c2018eae12c06b82f190cc97e580c3d3c563085068d0b62d67bc609af26d45b1aa0e972886118fa56b56e41df4d3acc761685f5b261ffd058201c6af6"
        hex"39ec87e4a95dd94e6930d71722c6d1d7df329f2937cd1548345d26b767d678ba10bff0fcc663269e3376f4005d194dfd0febc1b302e807ae7947653a910fb6ed2c58d0a4646e33ac9f633d2c88a7acdb7a192c23aa13f1133b178fadeff93bd9"
        hex"255a12f7505a81b7387bbcaf2b69a02983fcb1f0760a5a354af777ac6f1b25b41ede0f41c98e5a789c12e1849ea83292fa0e2ec9e3c60904d40ea129aa9bfc8d37d6ddb158b07eee159e3f531df614299da753ea227e2ffbf270bc20b0513bab"
        hex"28f7cfe6a0b76b75b8dbeac43e039ba1ea126addb90ed9ca841c1167c2b8e6d432e1ed2dbf09026b619f089e041d0628354276387e530b05aeeb8652f0cb20c53db54eb1d8c5286111eb66c02c2aee886c891f2d66e635b985ee915a0eff5dd9"
        hex"025c178b222bb3251458eacd3593f1871620ce561025d033c4c2a1354e92b2e22611a94466f9ef6e985fa72c1d2d2fbf053cbeb6be85d1c64ef357c2d459db542454b42934012ff778e8e1e5c7c819fee2af51fadb592ea7d025c25ec92be980"
        hex"3f40092e86c6ff92369760f1ae2aecda1306844488f157271e7fb4674783d6331660a3b2599d67d031089bf39dfb32d5f7c1f39cc762c14624d4113cb6e6fe9f0530f1045ffb5c20a9f194c64d1bffba49dfb7544174935a437a32185ba5e9d2"
        hex"24be84fe06b6e3df8f63f25bf8132b99980122bbb57b427dcb9cce48e9c2732405172209042ea906e3ff5ea1e856c643cbf689e363bfcd74ec5a196360fa6d883cd4ad01b5ceccb9cb65ac8ff460cc9a4a01c3dcdcdf95eb1366d31623d1c611"
        hex"14e9c2ef46ae06997baf594795cf642ee9755aab50c69b43a729f3519eaac4c733ca75b3f0eee249ba79ab97f811adf195a71f59794633f5976ba10ebcceb3f910e52756ef1e9062ab5ab4a3e7abe29f01ca703e109dc57666f4bdf1c401977a"
        hex"152dc28205bb989f84fbe0a3e64b252ca66794ecac42c4680a2d65b275c522f828ee5dddc9ef49eca187049b82679c92a9be74e888b098c3f256cebf8eb6a467371a00f9d51e93a5a03d0b7f462b723cffd9bf007efd4b5726d13b8be1f48264"
        hex"2eb7e75c62ba1d7f03cb784e41a6afedbcda222163972fc21085b1b564c36a892a779ccb539ab7a8516cad9b7b6bef5d835d73a49f9256f6bdd23430aa4b6176351ca417a677264f4df829ffa55bff4e3490dea36dc225b90f62a7fa9781637c"
        hex"109ad285b5b20bdeb94efe97b1c8afc0b84f7b41d9242e9e58ddc3c5093c81ae082af6fd0d473630b2b8a2bc9c3c6c495b69affe456cf7cee11714c3c3c31d161461c7f090cbda8b253994a27c72a0b29928db3aefa4e4a48cb2025d611f8af8"
        hex"0b2ee969275d2a3afb5c3ac05146da01ee3589add766f22be6331bbed92cd0f11d11a5a41cfdc731ecd7e52e3fc0ea81b2fe0bbb2801d148f75a05502903007a21936b3709c9ddd228f6e0aaa224955afd9b411fd260f42ad988d2920d39261e"
        hex"062320c5546cfe6217f6db99664de360cf6f96e8ecc28b4dba45254f1508ed920de133d07af9bdfdbb3ddfaab9107d2c9e03c630bf11a159216b2fa0fe0e667d35617094e3c1ecdb07317eadd26c63985d01bc36025637191c79dc65359ccbe1"
        hex"39042151c20fa2181845f35474d65b806d93f63448d5a5567478d0610442a97e2f88df0574fd97b6d0bcebb78ecf6769bd59aeed451f7d730a8d5481db79d68025fe91a88205b5698bd33087cd536326fc4ac8ec977ec807edc91cb72fe48a9f"
        hex"1b1775ad9c2ba1f118ce3b216324aff9a8d6a16e75745787031a71e5e49ee8811ca5356d21e15245f06da068e58121e48e7a9ab2b6b562fec7b9569d870d130606af4c91a11c52a5f02f13d8fe5a54b47c1c2c18212b5dafbaae1c2bbdee1249"
        hex"0941789280992dab6bc83d32da898d379f261fc54806d67718c33ec0db836a4a096d4deca9fd80930e56d62adf81e3fb15e9807041cbdbaba5033c878141211b35367b942f71e94c6699742642a6c6a2c14ad81e10a8c8bda2e8f6f45f3a1630"
        hex"20337671bc9d81451d638bc5f2d10caed48756373e93c5bc5d74aee8a21921823eb77d9c0afbd28c29159cbdaacb193c1b54282c4c6ab45ff23cfa21a60a6b333f7a9145cafc9f7e623f0e8ffad7eba26cede885c92b0f045c8f8d2350441652"
        hex"0a0b04b04775f033845870cf4d779d60dc8737800c3f9ff01bba6187ff9b6cb7059830cd83d371e5b9e629fa432d3f2456002bbe460926dbec347a8cbfa3f6231c7d70a41850b060aa600fb388961d6ec2914a44af5b27dcf0974e6620674486"
        hex"2fbdb6819b90002cfff42f87a37e1f7e804974280f792a3b09c3e6844ec64c401d419da8b49bd73f5f43a8edc44b16114ae57aa251bf34faf86b58c36df28ec82fcd8a73ef6217c754f8b6ec6cac929d22b6ce02ff0f4a7897a92612ab015105"
        hex"39a250eb25a92ea23bf75c9a37f2674ac0a410ca09810533ac44ca6c34b07ca1285855ef5de9622818dbc87cccd092a98b4c7dab24a2c546b43ef85ee9c1d9252ef973b323eb9f2dacd5a60002149109669b88ff52e8714b69be770a8ddbaf90"
        hex"11920f37c58326cfabcced87523d3cd90139c1a1195d0dad4d51bbdcc1cbb88c31057f191bda3f1eb5b6046f0bb930dfc97b8ca505eaa4daa1f747d6f21e175225154f7ac76edfc82196797946e293e8c8a7fb88fa583f929aad0fe50ea897f3"
        hex"17ace9f6367ac29273dbce8eccd375584c343adf14173d9b5a2573b5ff1105772efb03fdba217d2601c209f6d3aa19c25822c2c4668b27748a6a584b25e488b81bd0b43cf6ac7b6cd535a6c94e329ce6bc1d58d6ec3fc980d4df42944c639d09"
        hex"2bbadb54fd142142e5d9da726c6effc16e6add297776036a245dd4998df2a72a30159ecc49fe867eb8adc027605f0480c079aa5a6183056d6cdbe5db827c86b926e945e1ec402504a6ed02d41a30a4562c0c559743e089bbc72e8a29d2f9cfc8"
        hex"060ac054a5db07d9c3b43e3baa677f8be1c659644c5bd9cea2202e4d5b258f4c1e4ba404df70c4b25e94dc2f4506d1ce9aad21bfafd908b25dac884b545bd96d3ee4d554f56f3712029c9936bf7adbe897334592046b6442eb236159efedf7c1"
        hex"3f190b8ce44186a9a0be8c63cbd7f5a367cf64464b316b2a2770d117d11afea42f27f767edf5209aaebd36d25477daca86e032bdd7e4c7bd2d054a00fb999fc73e340445d8f274a2417ac07b2c83d6a4264e60af0e67193d47e043b0a82649c1"
        hex"373a9dfa29c8a12b7aea71ef6ccfbf371e93df71aefbcfeb37513542d19dfd9b2cf7fb4f8e34330256543c7be2b082e49c18591f6e1c3a5a6c523f2185d060a31187d223845b0f888a340dff2cc6f50bac15f7520f8b42b9aeddd3f9e45b697e"
        hex"13b37fdc3daa817b242c6975ee13c2a9b79595ddbc15bb52dad35f16aaed68fb2b70dc6b83faaf01e662fe5f488e695fa9123bfbb82c00329b1e76c6b262a284205b55ea84e99f479a3a65ed581eeae8da778031843cc16070ffaf1638ddb55f"
        hex"198c04b22df46de4f139c4a6c4aa889fe140e9deb97ec1e5d83e36ac7429d5d42e333c8d9b7786b891fcfe79ae56b4ea8bdab8e64f9bc5ce5bf32b48b20de75d0a47e570b4ea649089bba90bf61540edae5a8b037bf59110fbb5cb320d71595e"
        hex"1eb02ce09ed3c42604fa93fb09fac1e5de0b66a5678722308044dec1ac6c90d211c879e6cc2001607e1729b822dcfaa9a4c10a25d354fb0220f4ab5e9e3dec6404b806f5fc40f15e663eac16ba02923d97a2aca5f0efea8e8955a3ebc328cfa1"
        hex"3c671c8185114e52c21f7b779d05b6e76033737fd91cca5366554eb1c4910d0a33c5d496652b2dbdfd3281239d59ff1c1563814791b2afc1805ef9dcf20b49db26f047d6b5d2b3e74ad01e1635877fec3d2415c273cf9e078f3a035260a761ef"
        hex"17ae35d76c90b9906e2a8364786001e19ef5942f85db2eea7726c832574811542111fb41b79e1ed7b52ab074344555c1339f6dead74c81d02f2fe37dad97bccb354608988a63494d3d2e11d12f40981cee7e2e5e438e80bb2e976628f98a53b3"
        hex"27c26d5998de1ed7dcad2c1d9406af2d0afc389443f7706e67ad5dab07b98a2526e82b78ed77fa2c7ab0d9d86fe9b2b313c29ec0a20d31d99e7ceb88b4a61a893c9f896389f9168cd521e81f4c4c6e24dbfb316a685ef8a4a59e7810bc1af909"
        hex"00fddd234b11d1b77ff3595b74c94a57a9b7ca4605c626a4e70aa1de721edbc233f13cbaa0e9196a78dbd6c9d34827b74c749a37b337f5ffa2df7b8f0e3b6c2132060e681369e9d8ab9f49dc6978cd85292cf1c908b1bacdcd7585fa7f8363d1"
        hex"39c41360d52142a4e304dcda3b1ab0d7eedce909e07462196c4f459c5edc97482cb7647a82d0e70c9f9ef883157141fb657315bff86c274287181b816cbff53510aad98fc92ae62c7211437240dad844416d858f2b6ff9f85b8d2a8372d1c9c4"
        hex"39e3eecf71a7ae2934f557cf2af1ee809754caf22858816b84eac74a646e82463f92e6654a83ebe985ddbab5e9af40c00283536cd0ac92c96e0fec7c22a2d24f1a4cef4f366fa80772b85b9484942bc3b579cd3a36a9ef25e7999b9a9d1f23c9"
        hex"2fe1d605af674260ae9e13cf71ee8f6a3bebf4e3ca4ed0ba394c695e9d252cab145f74e0790888452e102444c8d28be2192d392c23c81a6935a6697b803d5f2d295d8c45443dbc0a49882de53c92a295b4f67cba2c49a945def3a9f71d53415d"
        hex"0f10617eb0f69195822e0518ad06efc45d33b14a68f93a9149abb0f89eb19e432d6cf48b81919824fb6cbbd325b14db6f4d29eed69b3b49cdd45b753aa32cb3e2c691a5519e9c0c89d496d6b60229bc852644573b45f0fb08b9a3bb8dd01cc6f"
        hex"3e50344adf9e70181e4f1df0b87dc829399c9ee2badb2e13c61728f79da7e69716591f51a54464eeffe9c42af21e6c8cc2a42392121a1e6afdd438569e98d90f1947350278ed8b4ac29c88486db3259d8c0a1e5e4b81ef93ca6c9cea8c8f107a"
        hex"3d9e5c3252cc09dc78ef80a16f38150c7944e8fb27f2f29cd5cd3ae48b2b19b90039e7c187e0b64f15757e5ac90bf4729d6ad6628ea7b4a8644992e8640af67d328144c12fffacabff017f0726c86f42ecaad7435eff270f462743f0126efabe"
        hex"289a1a58eb1dc10717fac769b508156d581d8b63aed8fe6902e08bcddf9e3395057bfbceaa7f9d5110feb295922ea73006a70b2553057ed6343724cac8bf4ea925188b12757e81d8e10352d5a6b540a61737b057aa34afb88c56e6a17f1021e4"
        hex"1a6a14f5b7a8fa4ed50a60244fbba4bc5470e4cd4ca7a326d8ae8664bc19517e06ed5244e5e6e55c987fe995cf281e6d873e8750d50f2813f13d6609528f08893d405c061d987d6d24e705f8736185498f9454ee641ca25331735e3183b892b5"
        hex"1cbe945e02625d9af40f5a2945a311fc95246ae07cce8c0777265fbc01facade010e279901e0b4a08f590e5a44b6667b3e608bc7d2411e9190c6538a916ea2981ec2e81eba84f4527aaef43f2ea98d3edcf8f753c705a54b53841c264b1d8d5e"
        hex"24bfa50b387752ab2b2abb064f9fa256657bea926afe83c236ad1a8f08d40d033019509b5d2ae404de984274aa3ef4867ec2046073bc6c3f3d1423ef91ee7be63aac5a5d82686358c9d49b48b950400761924b3f8d0ecf938cd8be4e3f59584c"
        hex"06c7910f20bb41ee397c7ecaeb48a3df55e3c1fa4e68086fe2704d8ca5ba246223c6d6d7e9778378aa9b5b0fd679f18c281e8bc4df7ea5c15506955ed1b8f1053fe91fe2197dd9fb61f1a1dfad1ca0a8164374878d697b210ebc2c3e3d4f8c26"
        hex"3dd8b348f904a835260a6d03077aa57895e87e79c6b57a60959181e0c8d600a103389707fb78a6cdd37640749bdf8eb4ca233398d0e5fd47a61ea4737aa64dde12346b6d34b5a3a2a5945bbc8f9687004496602632b129ac5e938052807eb80f"
        hex"1345203883e5d5e739a7535987694e281faf4c3dd24e110cfe9fd2db865ef5912a0b1896101a5f912afd8b0a3b26453a4ece2360537544fbb902f32c578a98c135e664add5f8be7fe49ca1b958176a15a7b96b0ea1c7c46f3555070530770cb0"
        hex"04f6d6fc27ec1c863e4f63092421ef0eaab82438835acb278a268f9988d3bda73fa582246051ed9ff122e3d1ccc01c36a79cb211797867b47ab9ac8628912f370fe3b2acef9da9e146d49c182b6b51836808cb27ce4594f07f40d04e087c7446"
        hex"28806266709d409c64e31001aa0e4bf7d775845ba6bd4fcec3efb72a8f9bd88e05cc8707a4a8505891814596f0918350747afc2ac84e3f421e02926be36e2dd71e8575b9c53ce2347a4db07ee9e9b5cac53f2255cc79ea0b32b350caa3046dd2"
        hex"3cb47390e17ad0e1489a56807e8ecdc2564f6123cd031da3dd1fa0b9c3c5c37e22279fb573b3cc7ab2f52e84360180614661e45d57b9b53c83527fb0e1fee6c714c6656712d334cb9245b75ed79b7c330f97ccc1312e13de6a1bc875deb306ee"
        hex"15f2fab594fde918257402cbaf896da4bd82e9fa34617b53203c2b5e036fb75b34ae1d4028bc2c096f1cbc30457473c606764eb076f46eec6f9f4f029afb0516073cc2b91f8be9ff4e994a104a7e887b48681399c6c0eab543f37119bb8b63db"
        hex"2b451514f63349198ff8e1555b1413e22d78c9e8ae80b61b275843237d233f8b09db9d38907d7b840adbac31fb4b5e85cff8807b44da0e9e365a9658fb67a06a0e43d37ad5c30a44e58e2b356b5a4964e2587483685b67533e103b176bb3e9a9"
        hex"202fa18c51ed788fc2f00b12a9399ccbf246cb0cb3c966986637e294ece1b98b178c3bf7adb7ebea4afec79ff0e8afbac04e5090623023dd324213788e4ef2d62c31f1d03e598adf81656d57e50ce17e151aaea3fd980b976293cd57883b6a0c"
        hex"3b5f876430b4038659a8dc3f5b2b946bf5da61a81c618c767fe266e9a30e3f7b32600ba257dd8f4cccadec6582f0b8ab700fa9d715607bc1635fab11b9452b113f3cc094a5a94baa3d028faf91320e8d04c4f2f8b99d6c8334874da52f6a1aad"
        hex"2d6c849a7f36d203aad0923e9dc8a82f2e986c1e51d2d787610fd4b909967c7f335e044574af4a51119f8c121b87684c543eefc05293202180676864689db542398d6da5df52be0f2582532176d01f444cd4a81750c2f0a8c38117bf364a84e7"
        hex"1507ba09ff6cb5067e070cd1c1f93334484514d910739e7562f254e9cd2781571bd43fae5ae3036a5e48e388255cac2ba01d7d62e322514f22b9a9ecfa904f38156130ee4dafaf7b8cc089682c3228b6cea7e681171289cdc19c38fc50a0bd0d"
        hex"3baeed3b1af88252ca21c63935d9ee7165738eeb6d30a9528945d7b63f01ca8f347de61a008ed33bfa78e0d6cae521ff31604f274d9aa991c536d08aa272dec33dc0a6d30124c35c02b53f10ec034e795b7a86af52f2c863fb14d93da10d3d3f"
        hex"2db23e4b00e9b862fa8c0a064980ebb3c28fce714b9d6f4b072d9eadcd56d5ed3b74342838683ae2f113d0de90f2c8c38689ce79d2ba6736c0a0c11d9f199c663ec307db36712062beb35cea94aa10c08dab3482e332fd1410e1bfaace0d095c"
        hex"0e8ba437b5868d61f9b973137c4cd952fb172339c03826388116bccce2c7103a1855c2efb5cdd92dcc912136d150121981e3c8d6fbfa98bc4be4fde4de4cbb2a022b4f6f9232a4174ed5dea64257b732557bf8ef423a23f530dbf1d566bd83d0"
        hex"311c7e0650fd0df0961a3dbbe1448ac8e358d6278b354ec965c9fde93c931d7002ea6f520d8a6683253b77000e940b65790018a0223cfc521ee7d177c48dfcea38917e1edb51748a5fbb75f21dc8d2a1e8f81ba27ce3d9a99e3dced9f7e0fed9"
        hex"0ae2bcdff44765e8ce56dca58b4acabd9d872ebe4d2575897b387b17b8782eda33f7b482a14583575fcc053d41b818d0ec976d64f9de13e80a27e392204740cb00b75044ab1e64540b082165ae1b24f0b209cf2e07ad988ee4be541416394255"
        hex"168c62c9a130712a06f4a8c81f566c8160228cbea15a77692c11007abcb2c1221535d4b22969a09e0d6d3403215f92a4753e0737d77dc64823be8c5f937282373bc14c9b1809e657aeac3014306121c59bbfeb3ad5a2d4c7011fc68eb5fb82fe"
        hex"1fe15d767035a0de4d243249f1fdd64552b2b4e6c5f12e782e395843d9b98d280b48ff1ab1beeacbe484d74b6986b26f22f7d237be137eae16871c31e4d9a89336b2261affee26ad698a05cbbc7c772e07c00d5c26e9c580d0c3efe799254eee"
        hex"3f0f57e0faeebd146fcdffed664d6f914c14ec292dbb99a571651f27ff60cf752f94163bf851c4346efc3dc14499588187521f18ba6aaf5ac4a5bbf14b682e792672f5d951a8b65365fd6712c2cb31ba7bd4f3b1cfaef1c70004bed7aa334499"
        hex"21f9e2c1e208498547ae6a187b19b42436329d273efb02e117e67aeb70447e7e30024bd517ec5f7b07f95ff73c636d072cd3d402cca08a0bf10dbe1931bf7ccc13e279f556c2b7f4ccc3e5cd647358988c6abc253b50bb1ea37f207b73a2a4c2"
        hex"1281b80868b59eebdb1eb7c39cdc4c0c2a905aeed49c56f111354ba29880d36f23a57028073c8ae241dcf1a624b22e19726fb7c7b48493f1a2f999a875945e4b07d0f467c5a310caacfff0ba7d33ba9348dda2f0894af2cb133d48c0f69a3f3f"
        hex"0f601e33638a3663d2de675c289223777ab17491936ced4a214cf05a0823b5153fe69835d03dc92d0506d30f886566abad05cee8729c518a6e7a28e84bfb4e0e2e256b5cbf22b0ab7a8ce34aa103d58fdb4e19386cb337e0ec0735aaefba2a32"
        hex"0f42e1965cab114ea6eb7c18ef6cda6d4bc9fd5ec09762b19d242c6cae55983116621280e50044ea7118b108f632200532acaafce72638ffff64906a78dd88d8172ffffbb51f92c37e77fa0ae83562dce3f5bcc99f8892366df59b0a424ebca6"
        hex"011f59cdd2ab0f5147cbf2341b7cf6b009569209d3aa1928407ac8218df820a81008e7bcbcc7617b92f5d375e6221a4db75f14b1fb23fd269a74c429ae5139b93376ec35f2c9b5d094cc5cd003376458b16a36fa66bdf9c9e4b0dbb66b681f52"
        hex"325542bd8f24ec9778cf734016a443ea2ae2badaf31d0ac8974aaf5a71c281e2332295450a5f8a0dd2d022d6e3002f85f6bb08ac20d92ea80b8fd101dbf7b4e024d83e9df6ec78e66825d54820b36efaa2ec6df809360e15c374a6483d4997e9"
        hex"1ada38ddd9f2045fa6a124eeb4d6f820de80df32c34dc05c4a9d1a1230609bb03a3c49eda2bb37f72bbbd0c138d8f34259f0849c9ebc3951ed7662aad9cba5e02a77c7913b8b566211616642f3facb01f7cd0e98e861ad1b7a94e6cffedbaf76"
        hex"308b47943fe47b7d85b846076e0de89f7833363f344fd245eea6db8d1cc4acc50f54259b6710bc5e74ec964949a575a4cf57045b75b00b2c3ff54d03e3cf4b0c22ba4801c3bf8e5da55d4699904c2d31c5c835ef5b3db7d2dfe877a539405157"
        hex"3d281dd8f4e04a84647b5e17b2e9d9c14aab31ea16eaf831bf730d997e1632fb2b8d7f8761d9cbae76bdbdc2c2fcfdcb2c50d3effe8ae7f86c4de8ce9452cb3d01ff021b22bc86de915e11ed2b94d5d5cd80657949f8e7be7c76fa0b41566ae7"
        hex"25fe45bd51b1208f6c609e914e0a0916df65b3436b0a33062cf9de14ce64ff8401782ec5495129666da0f103443abf453204a153cca079ababb948188480a9f017e2d4f2c82de8497044d9593d27b08dd96cdd7126fa123b3d26cfc16faff074"
        hex"0526a5825999c6a7c3fceace65965e1d99325bd69de9ec5c2a42a89311f77eb51f42ecc5cb80127f7a082eebe8b42bbba1e6532fd882b5940e5865e8a1dcddef289c00e5866b2d50e8cafa27d4248c7c637dc212c74b7594d3581fd2c58b48a7"
        hex"172b9feb64dffa4ae3bfd7e33250e37aaa33b60c41d988b3347a09f92f2489b33023710fb5275640f7bbc4ba1f4f23704bf1709c407ec15acb0d6d54c289f6532833ee5e8232f08a93c3f9dae4788c51e21607309160a62f56abab7418ce08d9"
        hex"3963716b8e0a4f2ccccf70c159831e19d039ba66a0b0bbf3b0b59db2153707c43121eb96aba2fbc19a680965e9dc5914eb6c5c7233c02d0a1c8296d421e738f332b60e92451ceba5d978c6d6243ffedf82eceba2bf139127df5a0c8e8d0b1707"
        hex"257cdbd9b57577d3b6771573ee145b648300fe41fdf822cea443c1eaae00a2fb12c9931971a1f8601f7dbf0aefd2aa74dbc8982c73322321bff389a8a429882f2eba456c640a22e92d8e01ccbf8bd1d6e802760a8cbf90ae5d9690cef84c9b1e"
        hex"275fb48078dafa653594665d853b12eacb8f6bbf5035c14ee4090837b6f2cd730028ff3a29a514f9b93557b16b46dddf9f2fa1d4da92519e01a530735d62c704109b360b92c60035793177b4c6aab5632acc3eb1033c74698f2d8cddbc71fe3e";

    /// @dev The MDS matrix, flattened. A function rather than a constant:
    /// Solidity does not allow constant arrays of value type.
    function mds() internal pure returns (uint256[9] memory m) {
        m[0] = 0x0bc7bd43470f271edd561175959cad06bb21d64fa314a778873762e6ffb4a5ca;
        m[1] = 0x21a33ba4ebd3dff40b654a6b390cb28f9eca5e028831b94079ea43b97f1bfffc;
        m[2] = 0x3185adbdc93210522ae0cc0eab26cc7077a14f1263f1714cdce8e4cd293208b1;
        m[3] = 0x164cd45138652570ac0442e35cde96aa4fb24c86983bb1b2b1620758f5caf318;
        m[4] = 0x25de1627ec1a5754e9c0db6969b0cc16a08f57225c1ffd9db833abc204f5612b;
        m[5] = 0x1f690f9372cca3a645304689367c2e0c823241c68dd5eaeb67be04f351680a4f;
        m[6] = 0x06c364440aa3b6cf17615d7114a87bdd15917ee6c2d6ec8451336adead4ab5a7;
        m[7] = 0x250b797d72cab6bdcf47520851e6d9e069927ff59ca0038c81fab3c8f2ec2261;
        m[8] = 0x2557460f3563ba3aa6c4a826ba8639377129acef2f2589b1302dcc8b61eea7bf;
    }

    /// @notice Copy the round constants into memory. One CODECOPY.
    function loadConstants() internal pure returns (bytes memory rc) {
        rc = ROUND_CONSTANTS;
    }

    /// @notice x^5 mod P, the legacy S-box. Three multiplications, against four
    /// for Kimchi's x^7 — the one place legacy is cheaper.
    function power5(uint256 x) internal pure returns (uint256) {
        uint256 x2 = mulmod(x, x, P);
        uint256 x4 = mulmod(x2, x2, P);
        return mulmod(x4, x, P);
    }

    /// @notice Multiply the state by the MDS matrix, in place.
    ///
    /// @dev In place, and that is not a style choice. Returning a new array and
    /// writing `state = mix(state)` rebinds the local pointer: every later write
    /// lands in the new array and the caller's state keeps only whatever was
    /// written before the rebind. It produced a plausible hash that matched
    /// nothing, and no compiler warning.
    function mix(uint256[3] memory s, uint256[9] memory m) internal pure {
        uint256 s0 = s[0];
        uint256 s1 = s[1];
        uint256 s2 = s[2];
        s[0] = addmod(
            addmod(mulmod(m[0], s0, P), mulmod(m[1], s1, P), P), mulmod(m[2], s2, P), P
        );
        s[1] = addmod(
            addmod(mulmod(m[3], s0, P), mulmod(m[4], s1, P), P), mulmod(m[5], s2, P), P
        );
        s[2] = addmod(
            addmod(mulmod(m[6], s0, P), mulmod(m[7], s1, P), P), mulmod(m[8], s2, P), P
        );
    }

    /// @notice One full permutation of the 3-element state.
    function permute(uint256[3] memory state, bytes memory rc) internal pure {
        // Hoisted: the matrix is the same for all 63 rounds, and rebuilding it
        // in memory each time was most of the cost.
        uint256[9] memory m = mds();

        // The initial round constant, which Kimchi does not have.
        {
            uint256 c0;
            uint256 c1;
            uint256 c2;
            assembly {
                let base := add(rc, 32)
                c0 := mload(base)
                c1 := mload(add(base, 32))
                c2 := mload(add(base, 64))
            }
            state[0] = addmod(state[0], c0, P);
            state[1] = addmod(state[1], c1, P);
            state[2] = addmod(state[2], c2, P);
        }

        for (uint256 round = 1; round <= FULL_ROUNDS; ++round) {
            state[0] = power5(state[0]);
            state[1] = power5(state[1]);
            state[2] = power5(state[2]);

            mix(state, m);

            uint256 c0;
            uint256 c1;
            uint256 c2;
            assembly {
                let base := add(add(rc, 32), mul(round, 96))
                c0 := mload(base)
                c1 := mload(add(base, 32))
                c2 := mload(add(base, 64))
            }
            state[0] = addmod(state[0], c0, P);
            state[1] = addmod(state[1], c1, P);
            state[2] = addmod(state[2], c2, P);
        }
    }

    /// @notice Sponge over field elements, rate 2.
    function hash(uint256[] memory input) public pure returns (uint256) {
        bytes memory rc = loadConstants();
        uint256[3] memory state;

        for (uint256 i = 0; i < input.length; i += 2) {
            state[0] = addmod(state[0], input[i], P);
            if (i + 1 < input.length) state[1] = addmod(state[1], input[i + 1], P);
            permute(state, rc);
        }
        return state[0];
    }

    /// @notice Pack a UTF-8 message the way `signMessage` does.
    ///
    /// @dev Each byte becomes eight bits, least significant first; the stream is
    /// then cut into 254-bit chunks and each chunk read as a little-endian field
    /// element. `Random_oracle_input.Legacy.pack_to_fields`, in other words —
    /// and the reason a message cannot simply be hashed as bytes.
    function packMessage(bytes memory message) internal pure returns (uint256[] memory fields) {
        uint256 bitCount = message.length * 8;
        uint256 fieldCount = (bitCount + 253) / 254;
        fields = new uint256[](fieldCount);

        for (uint256 bit = 0; bit < bitCount; ++bit) {
            uint256 byteIndex = bit / 8;
            uint256 bitInByte = bit % 8;
            uint256 value = (uint8(message[byteIndex]) >> bitInByte) & 1;
            if (value == 1) {
                fields[bit / 254] |= (1 << (bit % 254));
            }
        }
    }

    /// @notice Hash a displayable message, as a wallet would have signed it.
    function hashMessage(bytes memory message) public pure returns (uint256) {
        return hash(packMessage(message));
    }

    /// @dev Sponge state after absorbing "CodaSignature*******", precomputed.
    /// The prefix never changes on a given network, so absorbing it at every
    /// verification would burn a permutation for a constant.
    function testnetSalt() internal pure returns (uint256[3] memory s) {
        s[0] = 28132119227444686413214523693400847740858213284875453355294308721084881982354;
        s[1] = 24895072146662946646133617369498198544578131474807621989761680811592073367193;
        s[2] = 3216013753133880902260672769141972972810073620591719805178695684388949134646;
    }

    /// @notice The Schnorr challenge a wallet computed for a displayed message.
    ///
    /// @dev `hashMessageLegacy`: the public key and `r` go in as field elements
    /// *before* the message bits, and the whole lot is absorbed from the salted
    /// state. Field order is protocol — swapping any two verifies nothing.
    function challenge(uint256 pkx, uint256 pky, uint256 r, bytes memory message)
        public
        pure
        returns (uint256)
    {
        uint256[] memory packed = packMessage(message);
        uint256[] memory input = new uint256[](3 + packed.length);
        input[0] = pkx;
        input[1] = pky;
        input[2] = r;
        for (uint256 i = 0; i < packed.length; ++i) input[3 + i] = packed[i];

        bytes memory rc = loadConstants();
        uint256[3] memory state = testnetSalt();
        for (uint256 i = 0; i < input.length; i += 2) {
            state[0] = addmod(state[0], input[i], P);
            if (i + 1 < input.length) state[1] = addmod(state[1], input[i + 1], P);
            permute(state, rc);
        }
        return state[0];
    }
}
