// 手写 fixture：模拟官网 _virtual_resources-*.js 的数据块形状。
// 不是有效 JS 也没关系——解析器只做字面量扫描，不 eval。
// 覆盖：三种已知 status、未知 status、字段缺失、字符串里带 `{}` `,` 与转义反引号、
// 以及必须被排除的地图条目（link 以 /map/ 开头）。
var e = [
  {
    name: `示例包甲`, originalName: `Example Pack A`,
    icon: `https://example.invalid/a.png`, image: ``,
    author: `someone`, description: `描述里有花括号 { 和 } 还有逗号, 以及转义反引号 \` 与引号 "x"。`,
    featured: !0, link: `/modpacks/alpha`, date: 1725552e6, displayDate: `2024-9-6`,
    status: { type: `stopped` },
    versions: { loader: `forge`, mc: `1.18.2`, pack: `1.4.0` },
  },
  {
    name: `示例包乙`, originalName: `Example Pack B`,
    icon: `https://example.invalid/b.png`, image: ``,
    author: `other`, description: `普通描述`, featured: !1,
    link: `/modpacks/beta`, date: 17921664e5, displayDate: `2026-10-17`,
    status: { type: `maintaining` },
    versions: { loader: `neoforge`, mc: `1.21.1`, pack: `1.8.1` },
  },
  {
    name: `示例包丙`, originalName: `Example Pack C`,
    icon: ``, image: ``, author: `third`, description: `翻译中`,
    featured: !1, link: `/modpacks/gamma`, date: 0, displayDate: `待定`,
    status: { type: `translating` },
    versions: { loader: `fabric`, mc: `1.20.4`, pack: `最新版` },
  },
  {
    name: `示例包丁`, originalName: `Example Pack D`,
    icon: ``, image: ``, author: `fourth`, description: `停更但状态值改过`,
    featured: !1, link: `/modpacks/delta`, date: 0, displayDate: `2023-1-1`,
    status: { type: `paused` },
    versions: { loader: `forge`, mc: `1.12.2`, pack: `2.0` },
  },
  {
    name: `示例包戊`, originalName: `Example Pack E`,
    icon: ``, image: ``, author: `fifth`, description: `没有版本字段`,
    featured: !1, link: `/modpacks/epsilon`, date: 0, displayDate: `2022-1-1`,
    status: { type: `stopped` },
  },
  {
    name: `示例包己`, originalName: `Example Pack F`,
    icon: ``, image: ``, author: `sixth`, description: `没有状态字段`,
    featured: !1, link: `/modpacks/zeta`, date: 0, displayDate: `2022-1-2`,
    versions: { loader: `forge`, mc: `1.16.5`, pack: `3.1` },
  },
  {
    name: `示例包庚`, originalName: `Example Pack G`,
    icon: ``, image: ``, author: `seventh`, description: `status 在但 type 不在`,
    featured: !1, link: `/modpacks/eta`, date: 0, displayDate: `2022-1-3`,
    status: {}, versions: { loader: `forge`, mc: `1.19.2`, pack: null },
  },
  {
    name: `示例包辛`,
    icon: ``, image: ``, author: `eighth`, description: `没有 originalName`,
    featured: !1, link: `/modpacks/theta`, date: 0, displayDate: `2022-1-4`,
    status: { type: `maintaining` }, versions: { loader: `forge`, mc: `1.20.1`, pack: `1.0` },
  },
], t = [
  {
    name: `示例地图`, originalName: `Example Map`,
    icon: `/imgs/maps/x.png`, image: ``,
    author: `mapper`, description: `地图条目，不应进入整合包结果`,
    featured: !1, link: `/map/example-map`, date: 0, displayDate: `2023-1-1`,
    status: { type: `stopped` }, versions: { loader: `vanilla`, mc: `1.20.1`, pack: `1.0` },
  },
];
export { e as n, t as o };
