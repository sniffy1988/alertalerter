UPDATE "Channel"
SET "scrapTimeout" = 1500
WHERE lower(replace("link", '@', '')) LIKE '%tlknewsua'
   OR lower(replace("link", '@', '')) LIKE '%monitor1654';

UPDATE "Channel"
SET "scrapTimeout" = 3000
WHERE lower(replace("link", '@', '')) LIKE '%cxidua';
