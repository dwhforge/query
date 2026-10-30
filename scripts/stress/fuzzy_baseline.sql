-- Previous patch SQL, benchmark-only. Not used by production matching.
WITH rt AS MATERIALIZED (
 SELECT DISTINCT id,unnest(string_split(norm,' ')) AS token FROM __bench_r
), rare AS (
 SELECT token FROM rt WHERE length(token)>=2 GROUP BY token HAVING count(*)<=32
), lt AS (
 SELECT DISTINCT id,unnest(string_split(norm,' ')) AS token FROM __bench_l
), token_overlaps AS (
 SELECT lt.id AS lid, rt.id AS rid,count(*) AS hits
 FROM lt JOIN rare USING(token) JOIN rt USING(token) GROUP BY lt.id,rt.id
), token_pairs AS (
 SELECT lid,rid FROM token_overlaps
 QUALIFY row_number() OVER(PARTITION BY lid ORDER BY hits DESC,rid)<=16
), exact_freq AS (
 SELECT norm FROM __bench_r GROUP BY norm HAVING count(*)<=32
), candidates AS (
 SELECT lid,rid FROM token_pairs
 UNION
 SELECT l.id,r.id FROM __bench_l l JOIN __bench_r r ON l.norm=r.norm JOIN exact_freq f ON f.norm=r.norm
), scored AS (
 SELECT l.k AS from_key,r.k AS to_key,jaro_winkler_similarity(l.norm,r.norm) AS score
 FROM candidates c JOIN __bench_l l ON l.id=c.lid JOIN __bench_r r ON r.id=c.rid
), ranked AS (
 SELECT *,lead(score) OVER(PARTITION BY from_key ORDER BY score DESC,to_key) AS runner,
 row_number() OVER(PARTITION BY from_key ORDER BY score DESC,to_key) AS rank FROM scored
)
SELECT from_key,to_key,score,coalesce(score-runner<0.03,false) AS ambiguous
FROM ranked WHERE rank=1 AND score>=0.88 ORDER BY from_key
