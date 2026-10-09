import type { RecallStatus } from '@engramweave/contracts';
import { setTimeout as delay } from 'node:timers/promises';
export async function waitSemanticIndex(request: (route: string) => Promise<Response>, ready: (status: RecallStatus) => boolean = () => true): Promise<RecallStatus> {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await request('/v1/recall/status');
    if (!response.ok) throw new Error(`Semantic status HTTP ${response.status}`);
    const status = await response.json() as RecallStatus;
    if (status.state !== 'running' && ready(status)) return status;
    await delay(25);
  }
  throw new Error('Semantic indexing did not finish');
}
/** Synthetic, hand-labelled evaluation notes. They are not the user's library or established research evidence. */
export const recallCases = [
  ['40_Knowledge/visibility.md', '发布与可见性', 'volatile 让其他线程看到已经发布的值，但 counter++ 的读改写仍需要锁或原子操作；可见性并不保证复合操作安全。', '为什么别的线程读到了最新值，累加器却还会丢掉次数？'],
  ['40_Knowledge/idempotence.md', '幂等请求', '客户端超时重发同一个 request_id，服务器返回保存的完成结果；相同身份与不同内容冲突，不能再次扣款或再次发布文件。', '网络断开后再发一次，怎样避免钱被扣两回？'],
  ['40_Knowledge/repetition.md', '间隔重复', '记忆复习不是连续反复阅读。逐渐拉长回忆间隔，并在快忘记的时候主动提取，有助于长期保持。', '如何安排复习，过几个月还记得学过的东西？'],
  ['40_Knowledge/ownership.md', '缓存与权威', 'Markdown 文件是知识的权威数据；SQLite 是可重建的派生投影。重建数据库不能把旧缓存写回覆盖用户笔记。', '删掉应用数据库以后，个人内容应不应该跟着消失？'],
  ['40_Knowledge/causality.md', '相关与因果', '两个变量共同变化不等于其中一个导致另一个；混杂因素可能同时影响两者。随机分配有助于隔离因果效应。', '冰淇淋卖得多时溺水也多，是否说明吃甜品会导致事故？'],
  ['40_Knowledge/transactions.md', '原子提交', '事务中的所有更改共同成功或回滚，不能把一半完成的修改当成整体成功。跨文件操作需要预条件与中断恢复。', '多处修改进行到一半停电，怎样避免半成品被当作成功？'],
  ['10_Ideas/reading.md', '阅读间歇卡片', '设想做一个阅读练习：每完成一节就关闭书页，用自己的话写出关键观点，再和原文比较遗漏，避免只是划线。', '有没有办法检验自己看完一章到底懂了没有？'],
  ['10_Ideas/evidence.md', '逐句证据面板', '设想在写作界面中选一句结论，旁边显示它引用的论文段落和适用条件，便于识别超出证据范围的表达。', '写文章时，怎样马上查清某句话的依据和限制？'],
  ['10_Ideas/privacy.md', '离线个人助手', '尝试让个人笔记的向量模型与重排模型在本机运行；用户明确选择远端时才发送片段，以便控制私人材料流向。', '不想把日记上传服务器，还能按意思查找吗？'],
  ['10_Ideas/queue.md', '短任务让路', '为耗时推理设独立等待通道，快速的浏览和文件清理不排在模型等待后面，避免界面长时间没有反应。', '生成内容很慢时，能不能照样顺畅翻看和整理资料？'],
  ['10_Ideas/exploration.md', '检索盲测', '建立一组提前写好的改述查询，并冻结正确答案。用没有参与调参的案例检查召回，防止只是迎合几个演示问题。', '怎样判断搜索改进是真有用，而不是只对演示样例有效？'],
  ['10_Ideas/provenance.md', '引用导航', '想把整理后的概念与其原始网页、论文选段、用户 Annotation 相连，点击结果即可沿来源链逐步返回原始材料。', '从总结跳回当初摘录的网页或批注，界面可以怎么做？'],
  ['50_Research/placebo.md', '试验甲：双盲对照', '模拟研究记录：参与者被随机分配到治疗和安慰剂组，参与者与评估人员都不知道分组；报告需保留招募条件和不确定性。', '怎样排除受试者期望以及评分人的先入为主对疗效的影响？'],
  ['50_Research/publication.md', '试验乙：发表偏倚', '模拟研究记录：阳性实验更容易公开，未发表的阴性结果使汇总效果看起来更大。应检索注册记录与未发表研究。', '为什么把已刊登的实验合起来后，效果可能被夸大？'],
  ['50_Research/generalization.md', '试验丙：外推范围', '模拟研究记录：研究仅招募健康青年，短期改善不自动适用于老年慢性病患者或长期使用。结论必须受样本与随访条件约束。', '年轻健康人身上的短期发现，能直接用于老人多年治疗吗？'],
  ['50_Research/measurement.md', '试验丁：量表测量', '模拟研究记录：问卷自评与行为测量并不等价。只报告满意程度提高，不能推断实际工作表现一定变好。', '受访者说感觉更好，是否证明他们实际做事更有效率？'],
  ['50_Research/multiple.md', '试验戊：多重比较', '模拟研究记录：同时检验许多指标，会增大偶然显著的机会；预注册主指标并校正多重检验，有助于避免选择性汇报。', '测了上百个项目后挑出一个 p 值很小的，有什么问题？'],
  ['50_Research/attrition.md', '试验己：失访', '模拟研究记录：中途退出的受试者可能与留在研究中的人系统性不同，完整案例分析可能产生偏差。需报告退出原因并做敏感性分析。', '只分析坚持到最后的参与者，会不会把结果算得太乐观？'],
] as const;
