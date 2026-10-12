import { IntelligenceSourceSchema } from '../../packages/contracts/intelligence';

// 用户已授权公开资料检索与接入；每个来源仍显式登记域名、用途和适度频率。
export const publicIntelligenceSources = [
  {
    sourceId: 'zhejiang-maritime',
    name: '浙江海事局航行警告',
    kind: 'api',
    adapter: 'maritime-html',
    endpoint: 'https://www.zj.msa.gov.cn/ZJ/wszw/bmcx/hsskcx/hxjg/',
    allowedHosts: ['www.zj.msa.gov.cn'],
    trust: 'official',
    pollSeconds: 1800,
  },
  {
    sourceId: 'shanghai-maritime',
    name: '上海海事门户→全国海事公告（筛选沪航警）',
    kind: 'api',
    adapter: 'maritime-html',
    endpoint: 'https://www.msa.gov.cn/94df14ce1110415da44e67593e76619f/index.jhtml',
    allowedHosts: ['www.msa.gov.cn'],
    trust: 'official',
    pollSeconds: 1800,
  },
  {
    sourceId: 'gdacs-near-china',
    name: 'GDACS 中国近海TC/TS事件中心',
    kind: 'api',
    adapter: 'gdacs',
    endpoint: 'https://www.gdacs.org/gdacsapi/api/Events/geteventlist/EVENTS4APP',
    allowedHosts: ['www.gdacs.org'],
    trust: 'official',
    pollSeconds: 3600,
  },
  {
    sourceId: 'gdelt-maritime-news',
    name: 'GDELT中文航运新闻候选',
    kind: 'api',
    adapter: 'gdelt',
    endpoint:
      'https://api.gdeltproject.org/api/v2/doc/doc?query=shipping%20sourcelang%3Achinese&mode=ArtList&format=json&maxrecords=20&timespan=1d',
    allowedHosts: ['api.gdeltproject.org'],
    trust: 'aggregator',
    pollSeconds: 3600,
  },
].map((s) =>
  IntelligenceSourceSchema.parse({
    ...s,
    enabled: true,
    authorizationConfirmed: true,
    requestsPerMinute: 6,
    maxDocuments: 5,
    timeoutSeconds: 20,
  }),
);
