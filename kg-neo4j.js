const neo4j = require('neo4j-driver');

function toEpochMs(input) {
    const raw = String(input || '').trim();
    if (!raw) return Date.now();
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
    const ms = Date.parse(withZone);
    return Number.isFinite(ms) ? ms : Date.now();
}

class KgNeo4jService {
    constructor() {
        this.enabled = String(process.env.KG_ENABLED || '1') === '1';
        this.uri = String(process.env.NEO4J_URI || 'bolt://localhost:7687').trim();
        this.user = String(process.env.NEO4J_USER || 'neo4j').trim();
        this.password = String(process.env.NEO4J_PASSWORD || 'password123').trim();
        this.driver = null;
    }

    isReady() {
        return this.enabled && !!this.driver;
    }

    async init() {
        if (!this.enabled) return { enabled: false, ready: false, reason: 'KG_ENABLED=0' };
        if (this.driver) return { enabled: true, ready: true };
        try {
            this.driver = neo4j.driver(
                this.uri,
                neo4j.auth.basic(this.user, this.password),
                { disableLosslessIntegers: true }
            );
            await this.driver.verifyConnectivity();
            await this.ensureSchema();
            return { enabled: true, ready: true };
        } catch (e) {
            this.driver = null;
            return { enabled: true, ready: false, reason: e.message };
        }
    }

    async ensureSchema() {
        if (!this.driver) return;
        const session = this.driver.session();
        try {
            await session.run('CREATE CONSTRAINT kg_book_id IF NOT EXISTS FOR (b:Book) REQUIRE b.id IS UNIQUE');
            await session.run('CREATE CONSTRAINT kg_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE');
            await session.run('CREATE CONSTRAINT kg_author_name IF NOT EXISTS FOR (a:Author) REQUIRE a.name IS UNIQUE');
            await session.run('CREATE CONSTRAINT kg_category_name IF NOT EXISTS FOR (c:Category) REQUIRE c.name IS UNIQUE');
            await session.run('CREATE CONSTRAINT kg_tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE');
        } finally {
            await session.close();
        }
    }

    async upsertBooks(books = [], tagMap = new Map()) {
        if (!this.driver || !Array.isArray(books) || !books.length) return 0;
        const rows = books.map((b) => ({
            id: Number(b.id),
            title: String(b.title || ''),
            author: String(b.author || '').trim(),
            category: String(b.category || '').trim(),
            tags: Array.from(tagMap.get(Number(b.id)) || [])
        })).filter((r) => r.id > 0);
        if (!rows.length) return 0;

        const session = this.driver.session();
        try {
            await session.run(
                `
                UNWIND $rows AS row
                MERGE (b:Book {id: row.id})
                SET b.title = row.title
                FOREACH (_ IN CASE WHEN row.author <> '' THEN [1] ELSE [] END |
                    MERGE (a:Author {name: row.author})
                    MERGE (b)-[:WRITTEN_BY]->(a)
                )
                FOREACH (_ IN CASE WHEN row.category <> '' THEN [1] ELSE [] END |
                    MERGE (c:Category {name: row.category})
                    MERGE (b)-[:BELONGS_TO]->(c)
                )
                FOREACH (tag IN row.tags |
                    MERGE (t:Tag {name: tag})
                    MERGE (b)-[:HAS_TAG]->(t)
                )
                `,
                { rows }
            );
            return rows.length;
        } finally {
            await session.close();
        }
    }

    async upsertInteractions(events = []) {
        if (!this.driver || !Array.isArray(events) || !events.length) return 0;
        const rows = events
            .map((e) => ({
                user_id: Number(e.user_id),
                book_id: Number(e.book_id),
                weight: Number(e.weight || 0),
                ts_ms: toEpochMs(e.created_at)
            }))
            .filter((r) => r.user_id > 0 && r.book_id > 0 && Number.isFinite(r.weight) && r.weight !== 0);
        if (!rows.length) return 0;
        const session = this.driver.session();
        try {
            await session.run(
                `
                UNWIND $rows AS row
                MERGE (u:User {id: row.user_id})
                MERGE (b:Book {id: row.book_id})
                MERGE (u)-[r:INTERACTED]->(b)
                ON CREATE SET r.weight = row.weight, r.ts_ms = row.ts_ms
                ON MATCH SET r.weight = coalesce(r.weight, 0) + row.weight, r.ts_ms = row.ts_ms
                `,
                { rows }
            );
            return rows.length;
        } finally {
            await session.close();
        }
    }

    async computeKgScores(userId, candidateBookIds = [], sinceDays = 30) {
        if (!this.driver) return new Map();
        const uid = Number(userId || 0);
        const ids = Array.from(new Set((candidateBookIds || []).map((x) => Number(x)).filter((x) => x > 0)));
        if (!uid || !ids.length) return new Map();
        const sinceMs = Date.now() - Math.max(1, Number(sinceDays || 30)) * 24 * 3600 * 1000;
        const session = this.driver.session();
        try {
            const interactedRes = await session.run(
                `
                MATCH (u:User {id:$uid})-[r:INTERACTED]->(b:Book)
                WHERE coalesce(r.ts_ms, 0) >= $since_ms
                OPTIONAL MATCH (b)-[:WRITTEN_BY]->(a:Author)
                OPTIONAL MATCH (b)-[:BELONGS_TO]->(c:Category)
                OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
                RETURN b.id AS book_id, coalesce(sum(r.weight),0) AS weight,
                       collect(DISTINCT a.name) AS authors,
                       collect(DISTINCT c.name) AS categories,
                       collect(DISTINCT t.name) AS tags
                `,
                { uid, since_ms: sinceMs }
            );
            if (!interactedRes.records.length) return new Map();
            const inter = interactedRes.records.map((r) => ({
                book_id: Number(r.get('book_id')),
                weight: Number(r.get('weight') || 0),
                authors: new Set((r.get('authors') || []).filter(Boolean)),
                categories: new Set((r.get('categories') || []).filter(Boolean)),
                tags: new Set((r.get('tags') || []).filter(Boolean))
            }));
            const maxWeight = Math.max(1e-6, ...inter.map((x) => Math.max(0, x.weight)));

            const candidateRes = await session.run(
                `
                UNWIND $ids AS bid
                MATCH (b:Book {id: bid})
                OPTIONAL MATCH (b)-[:WRITTEN_BY]->(a:Author)
                OPTIONAL MATCH (b)-[:BELONGS_TO]->(c:Category)
                OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
                RETURN b.id AS book_id,
                       collect(DISTINCT a.name) AS authors,
                       collect(DISTINCT c.name) AS categories,
                       collect(DISTINCT t.name) AS tags
                `,
                { ids }
            );

            const out = new Map();
            for (const r of candidateRes.records) {
                const bid = Number(r.get('book_id'));
                const bAuthors = new Set((r.get('authors') || []).filter(Boolean));
                const bCategories = new Set((r.get('categories') || []).filter(Boolean));
                const bTags = new Set((r.get('tags') || []).filter(Boolean));

                let best = 0;
                let reason = '';
                for (const src of inter) {
                    if (src.book_id === bid) continue;
                    const wn = Math.max(0, src.weight) / maxWeight;
                    let s = 0;
                    const sameAuthor = [...bAuthors].some((x) => src.authors.has(x));
                    const sameCategory = [...bCategories].some((x) => src.categories.has(x));
                    if (sameAuthor) s += 0.45 * wn;
                    if (sameCategory) s += 0.2 * wn;
                    if (bTags.size && src.tags.size) {
                        let interCnt = 0;
                        for (const t of bTags) if (src.tags.has(t)) interCnt++;
                        const union = bTags.size + src.tags.size - interCnt;
                        const jaccard = union > 0 ? interCnt / union : 0;
                        s += 0.35 * jaccard * wn;
                    }
                    if (s > best) {
                        best = s;
                        reason = sameAuthor ? '同作者' : (sameCategory ? '同分类' : '同标签');
                    }
                }
                out.set(bid, { score: Math.max(0, Math.min(1, best)), reason: reason || '知识图谱关系相似' });
            }
            return out;
        } finally {
            await session.close();
        }
    }
}

module.exports = { KgNeo4jService };
