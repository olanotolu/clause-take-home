export const WORD_SEARCH_SQL = `WITH queries AS MATERIALIZED (
        SELECT ordinality::integer AS term,to_tsquery('english',value) AS query FROM unnest($1::text[]) WITH ORDINALITY AS q(value,ordinality)
      ), matches AS MATERIALIZED (
        SELECT DISTINCT ON(c.document_id,q.term,split_part(c.chunk_id,':',1)) c.document_id,q.term,c.chunk_no,q.query,c.search
        FROM queries q JOIN document_chunks c ON c.search @@ q.query
        WHERE (cardinality($2::text[])=0 OR c.document_id=ANY($2))
        ORDER BY c.document_id,q.term,split_part(c.chunk_id,':',1),c.chunk_no
      ), scores AS (
        SELECT document_id,term,max(ts_rank(search,query,1)) AS score FROM matches GROUP BY document_id,term
        UNION ALL
        SELECT d.id,q.term,ts_rank(d.title_search,q.query,1) FROM queries q JOIN documents d ON d.title_search @@ q.query
        WHERE (cardinality($2::text[])=0 OR d.id=ANY($2))
      ), terms AS (
        SELECT document_id,term,max(score) AS score FROM scores GROUP BY document_id,term
      ), ranked AS MATERIALIZED (
        SELECT document_id,sum(score) AS score FROM terms GROUP BY document_id HAVING count(*)=$3
      ), page AS MATERIALIZED (
        SELECT d.id,d.title,d.version,COALESCE(d.content_utf16,length(d.content)) AS size,r.score,d.seq
        FROM ranked r JOIN documents d ON d.id=r.document_id ORDER BY r.score DESC,d.seq LIMIT $4 OFFSET $5
      ) SELECT totals.total,page.id,page.title,page.version,page.size,page.score,COALESCE(c.content,'') AS content,
        GREATEST(0,c.start_offset-200) AS "contentOffset"
      FROM (SELECT count(*) AS total FROM ranked) totals LEFT JOIN page ON true
      LEFT JOIN LATERAL (
        SELECT chunk_no FROM matches WHERE document_id=page.id AND term=1
        ORDER BY ts_rank(search,query,1) DESC,chunk_no LIMIT 1
      ) best ON true
      LEFT JOIN document_chunks c ON c.document_id=page.id AND c.chunk_no=best.chunk_no
      ORDER BY page.score DESC,page.seq`;
