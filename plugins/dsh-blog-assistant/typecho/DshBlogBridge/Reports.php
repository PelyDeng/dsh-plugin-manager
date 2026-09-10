<?php
/** Read-only reports over compact article projections; no body or private comment metadata is returned. */
trait DshBlogBridge_Reports
{
    private function report(array $input): array
    {
        $mode = $input['report'] ?? '';
        $options = [
            'overview' => [], 'taxonomy' => ['kind','emptyOnly','page','pageSize'],
            'catalog' => ['groupBy','page','pageSize'], 'timeline' => ['groupBy','page','pageSize'],
            'ranking' => ['sortBy','order','page','pageSize']
        ];
        $this->demand(is_string($mode) && isset($options[$mode]));
        $this->demand(!array_diff(array_keys($input), array_merge(['action','protocolVersion','report','filters','start','end','timeZone'], $options[$mode])));
        $filters = $input['filters'] ?? []; $this->demand(is_array($filters));
        $this->demand(!array_diff(array_keys($filters), ['query','title','content','category','tag','dateFrom','dateTo','dateField','status','categoryId','tagId','includeDescendants','missing','hasSavedDraft']));
        foreach (['query','title','content','category','tag'] as $key) { if (isset($filters[$key])) { $this->demand(is_string($filters[$key]) && mb_strlen($filters[$key]) <= 200); $filters[$key] = trim($filters[$key]); } }
        $filters['status'] = $filters['status'] ?? 'published';
        $page = $input['page'] ?? 1; $pageSize = $input['pageSize'] ?? 500;
        $this->demand(is_int($page) && $page >= 1 && $page <= 10000 && is_int($pageSize) && $pageSize >= 1 && $pageSize <= 500);
        foreach (['categoryId','tagId'] as $key) { if (isset($filters[$key])) { $this->id($filters[$key]); } }
        foreach (['includeDescendants','hasSavedDraft'] as $key) { if (isset($filters[$key])) { $this->demand(is_bool($filters[$key])); } }
        $this->demand(!isset($input['emptyOnly']) || is_bool($input['emptyOnly']));
        $this->demand(!isset($filters['missing']) || in_array($filters['missing'], ['category','tag','either','both'], true));
        $this->demand(empty($filters['categoryId']) || empty($filters['category']));
        $this->demand(empty($filters['tagId']) || empty($filters['tag']));
        $this->demand(empty($filters['includeDescendants']) || !empty($filters['categoryId']) || !empty($filters['category']));
        $kind = $input['kind'] ?? 'category'; $this->demand(in_array($kind, ['category','tag'], true));
        $groupBy = $input['groupBy'] ?? ($mode === 'timeline' ? 'month' : 'category');
        $this->demand(in_array($groupBy, $mode === 'timeline' ? ['day','month','year'] : ['category','tag','month','year','none'], true));
        $sortBy = $input['sortBy'] ?? 'modified'; $order = $input['order'] ?? 'desc';
        $this->demand(in_array($sortBy, ['created','modified','comments'], true) && in_array($order, ['asc','desc'], true));
        $this->demand(!isset($input['timeZone']) || $input['timeZone'] === 'Asia/Shanghai');
        $db = $this->bridgeDb;
        $this->transactionalStorage();
        // All projections in a report see the same snapshot, including relationships and pending drafts.
        $db->query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', \Typecho\Db::WRITE);
        $db->query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', \Typecho\Db::WRITE);
        try {
            [$rows, $terms, $relations, $pending] = $this->reportRows($filters, $input);
            $totals = $this->reportCounts($rows);
            $base = ['reportVersion'=>1, 'report'=>$mode, 'complete'=>true, 'totals'=>$totals,
                'scope'=>['status'=>$filters['status'], 'articleUnit'=>'distinct rootCid', 'versionUnit'=>'cid', 'dateField'=>$filters['dateField'] ?? 'modified', 'timeZone'=>'Asia/Shanghai'],
                'note'=>'文章数按 rootCid 去重，版本数包含匹配的保存稿；跨分类/标签或时间桶可能重复，组计数不能直接相加。created 为文章设定时间，modified 为每个版本最后修改时间，并非首次发布或修改次数。'];
            if ($mode === 'overview' || $mode === 'ranking') { $comments = $this->reportComments(array_keys($this->reportRoots($rows))); }
            if ($mode === 'overview') {
                $withoutCategory = []; $withoutTag = []; $withDraft = []; $used = ['category'=>[], 'tag'=>[]];
                foreach ($rows as $row) {
                    $root = $this->reportRoot($row); $has = ['category'=>false, 'tag'=>false];
                    foreach ($relations[$row['cid']] ?? [] as $mid) {
                        if (!isset($terms[$mid])) continue;
                        $type = $terms[$mid]['type']; $has[$type] = true;
                        foreach ($this->reportPath($terms,$mid) as $ancestor) $used[$type][$ancestor['id']] = true;
                    }
                    if (!$has['category']) $withoutCategory[$root] = true;
                    if (!$has['tag']) $withoutTag[$root] = true;
                    if (isset($pending[$root]) || $row['type'] === 'post_draft') $withDraft[$root] = true;
                }
                $base['articlesWithSavedDraft'] = count($withDraft);
                $base['articlesWithUncategorizedVersion'] = count($withoutCategory);
                $base['articlesWithUntaggedVersion'] = count($withoutTag);
                foreach (['category','tag'] as $type) { $total = count(array_filter($terms, fn($t)=>$t['type'] === $type)); $base['taxonomy'][$type] = ['totalTerms'=>$total, 'usedInScope'=>count($used[$type]), 'emptyInScope'=>$total - count($used[$type]), 'includesDescendants'=>$type === 'category']; }
                $base['comments'] = ['approved'=>0, 'waiting'=>0, 'spam'=>0, 'other'=>0];
                foreach ($comments as $counts) { foreach ($counts as $status=>$count) { $base['comments'][$status] += $count; } }
                $base['commentScope'] = '匹配文章 rootCid 下的当前原生 comment，不含 pingback/trackback；文章日期条件不限制评论时间。';
                return $base;
            }
            if ($mode === 'ranking') {
                $selected = [];
                foreach ($rows as $row) {
                    $root = $this->reportRoot($row);
                    // Prefer the matching public version; otherwise the most recently modified matching version.
                    $score = [$this->reportPublished($row) ? 1 : 0, (int)$row['modified'], (int)$row['cid']];
                    if (!isset($selected[$root]) || $score > $selected[$root]['score']) $selected[$root] = ['row'=>$row, 'score'=>$score];
                }
                $items = [];
                foreach ($selected as $root=>$selectedRow) {
                    $row = $selectedRow['row'];
                    $items[] = $this->reportTitle($row) + ['created'=>(int)$row['created'], 'modified'=>(int)$row['modified'], 'approvedComments'=>$comments[$root]['approved'] ?? 0, 'hasSavedDraft'=>isset($pending[$root]) || $row['type'] === 'post_draft'];
                }
                $key = $sortBy === 'comments' ? 'approvedComments' : $sortBy;
                usort($items, fn($a,$b)=>(($a[$key] <=> $b[$key]) ?: ($a['cid'] <=> $b['cid'])) * ($order === 'asc' ? 1 : -1));
                $base['selection'] = '每篇文章选匹配的公开版本，否则选最近修改的匹配版本；时间戳为秒。评论数按 rootCid，非阅读量。';
                return $base + $this->reportPage($items, $page, $pageSize);
            }
            if ($mode === 'taxonomy') {
                $direct = []; $subtree = [];
                foreach ($rows as $row) {
                    foreach ($relations[$row['cid']] ?? [] as $mid) {
                        if (!isset($terms[$mid]) || $terms[$mid]['type'] !== $kind) continue;
                        $direct[$mid][$row['cid']] = $this->reportRoot($row);
                        foreach ($this->reportPath($terms, $mid) as $ancestor) $subtree[$ancestor['id']][$row['cid']] = $this->reportRoot($row);
                    }
                }
                $items = [];
                foreach ($terms as $mid=>$term) {
                    if ($term['type'] !== $kind) continue;
                    $versions = $direct[$mid] ?? []; $children = $subtree[$mid] ?? [];
                    if (!empty($input['emptyOnly']) && count($children)) continue;
                    $items[] = $this->reportTerm($terms,$mid) + ['articleCount'=>count(array_unique(array_values($versions))), 'versionCount'=>count($versions), 'subtreeArticleCount'=>count(array_unique(array_values($children))), 'subtreeVersionCount'=>count($children)];
                }
                $base['kind'] = $kind; $base['emptyScope'] = 'emptyOnly 按当前文章筛选范围判断，分类含全部子级；不代表全站永久未使用。';
                return $base + $this->reportPage($items,$page,$pageSize);
            }
            $groups = []; $dateField = $filters['dateField'] ?? 'modified';
            foreach ($rows as $row) {
                if ($groupBy === 'category' || $groupBy === 'tag') {
                    $keys = array_values(array_filter($relations[$row['cid']] ?? [], fn($mid)=>isset($terms[$mid]) && $terms[$mid]['type'] === $groupBy));
                    if (!$keys) $keys = [0];
                } else { $keys = [$groupBy === 'none' ? 'all' : $this->reportDate((int)$row[$dateField],$groupBy)]; }
                foreach ($keys as $key) {
                    if (!isset($groups[$key])) {
                        $term = ($groupBy === 'category' || $groupBy === 'tag') ? ($key ? $this->reportTerm($terms,$key) : ['id'=>0,'name'=>$groupBy === 'category' ? '未分类' : '无标签','parent'=>0,'path'=>[]]) : ['name'=>$key];
                        $groups[$key] = ['term'=>$term, 'rows'=>[]];
                    }
                    $groups[$key]['rows'][$row['cid']] = $row;
                }
            }
            if ($groupBy === 'month' || $groupBy === 'year' || $groupBy === 'day') krsort($groups, SORT_STRING);
            else ksort($groups, SORT_NATURAL);
            $base['groupBy'] = $groupBy;
            if ($mode === 'timeline') {
                $items = [];
                foreach ($groups as $key=>$group) $items[] = ['period'=>(string)$key] + $this->reportCounts(array_values($group['rows']));
                $base['timeScope'] = '仅返回有匹配记录的时间桶；0 时间戳返回 unknown。多版本跨桶时文章数不可相加。';
                return $base + $this->reportPage($items,$page,$pageSize);
            }
            // Catalog pages contain group memberships; whole-scope counts remain exact on every page.
            $skip = ($page - 1) * $pageSize; $remaining = $pageSize; $total = 0; $items = [];
            foreach ($groups as $group) {
                $members = array_values($group['rows']); $count = count($members); $total += $count;
                if ($skip >= $count) { $skip -= $count; continue; }
                if (!$remaining) continue;
                $part = array_slice($members,$skip,$remaining); $skip = 0; $remaining -= count($part);
                $items[] = $group['term'] + $this->reportCounts($members) + ['returnedVersions'=>count($part), 'items'=>array_map(fn($r)=>$this->reportTitle($r),$part)];
            }
            return $base + ['groups'=>$items, 'totalGroups'=>count($groups), 'totalEntries'=>$total, 'page'=>$page, 'pageSize'=>$pageSize, 'hasMore'=>$page*$pageSize < $total,
                'pageUnit'=>'分组关联条目；同篇多分类会多次出现。组内计数是完整范围，items可能为本页的一部分。分类仅列直接关联，path 给出完整父级。'];
        } finally { $db->query('ROLLBACK', \Typecho\Db::WRITE); }
    }
    private function reportRows(array $filters, array $input): array
    {
        $db = $this->bridgeDb;
        $termRows = $db->fetchAll($db->select('mid','name','slug','parent','type')->from('table.metas')->where('type = ? OR type = ?', 'category','tag')->order('mid', \Typecho\Db::SORT_ASC)->limit(10001));
        $this->demand(count($termRows) <= 10000, 'report-too-large', 413);
        $terms = []; foreach ($termRows as $term) $terms[(int)$term['mid']] = $term;
        $queryFilters = $filters;
        $categoryIds = [];
        if (!empty($filters['includeDescendants'])) {
            foreach ($terms as $mid=>$term) if ($term['type'] === 'category' && ((!empty($filters['categoryId']) && $mid === $filters['categoryId']) || (!empty($filters['category']) && $term['name'] === $filters['category']))) $categoryIds[$mid] = true;
            foreach ($terms as $mid=>$term) if ($term['type'] === 'category') foreach ($this->reportPath($terms,$mid) as $ancestor) if (isset($categoryIds[$ancestor['id']])) { $categoryIds[$mid] = true; break; }
            unset($queryFilters['category']);
        }
        $queryFilters['start'] = $input['start'] ?? null; $queryFilters['end'] = $input['end'] ?? null;
        [$sql] = $this->searchQuery($queryFilters, 'DISTINCT table.contents.cid, table.contents.parent, table.contents.title, table.contents.type, table.contents.status, table.contents.created, table.contents.modified');
        foreach (['category','tag'] as $type) {
            $ids = $type === 'category' && !empty($filters['includeDescendants']) ? array_keys($categoryIds) : (isset($filters[$type.'Id']) ? [$filters[$type.'Id']] : null);
            if ($ids !== null) $sql->join('table.relationships report_'.$type.'_rel','report_'.$type.'_rel.cid = table.contents.cid')->join('table.metas report_'.$type.'_meta','report_'.$type.'_meta.mid = report_'.$type.'_rel.mid')->where('report_'.$type.'_meta.type = ? AND report_'.$type.'_meta.mid IN ?', $type,$ids ?: [0]);
        }
        // ponytail: bounded in-process aggregation for personal blogs; use SQL aggregates/streaming if scopes exceed 20k versions.
        $rows = $db->fetchAll($sql->order('table.contents.modified', \Typecho\Db::SORT_DESC)->order('table.contents.cid', \Typecho\Db::SORT_DESC)->limit(20001));
        $this->demand(count($rows) <= 20000, 'report-too-large', 413);
        $cids = array_column($rows,'cid'); $roots = array_keys($this->reportRoots($rows)); $relations = []; $pending = [];
        if ($cids) {
            $links = $db->fetchAll($db->select('cid','mid')->from('table.relationships')->where('cid IN ?', $cids)->limit(200001));
            $this->demand(count($links) <= 200000, 'report-too-large', 413);
            foreach ($links as $link) $relations[(int)$link['cid']][(int)$link['mid']] = (int)$link['mid'];
            $drafts = $db->fetchAll($db->select('parent')->from('table.contents')->where('type = ? AND parent IN ?', 'post_draft',$roots)->group('parent'));
            foreach ($drafts as $draft) $pending[(int)$draft['parent']] = true;
        }
        $rows = array_values(array_filter($rows, function($row) use($filters,$relations,$terms,$pending) {
            if (isset($filters['hasSavedDraft']) && $filters['hasSavedDraft'] !== (isset($pending[$this->reportRoot($row)]) || $row['type'] === 'post_draft')) return false;
            if (!isset($filters['missing'])) return true;
            $has = ['category'=>false,'tag'=>false];
            foreach ($relations[$row['cid']] ?? [] as $mid) if (isset($terms[$mid])) $has[$terms[$mid]['type']] = true;
            switch ($filters['missing']) { case 'category': return !$has['category']; case 'tag': return !$has['tag']; case 'both': return !$has['category'] && !$has['tag']; default: return !$has['category'] || !$has['tag']; }
        }));
        return [$rows,$terms,$relations,$pending];
    }
    private function reportRoot(array $row): int { return (int)($row['parent'] ?: $row['cid']); }
    private function reportPublished(array $row): bool { return $row['type'] === 'post' && $row['status'] === 'publish'; }
    private function reportRoots(array $rows): array { $roots = []; foreach ($rows as $row) $roots[$this->reportRoot($row)] = true; return $roots; }
    private function reportCounts(array $rows): array
    {
        $published = []; $drafts = 0; $statuses = [];
        foreach ($rows as $row) {
            if ($this->reportPublished($row)) $published[$this->reportRoot($row)] = true;
            if ($row['type'] === 'post_draft') $drafts++;
            $status = $row['status']; $statuses[$status] = ($statuses[$status] ?? 0) + 1;
        }
        return ['articleCount'=>count($this->reportRoots($rows)), 'versionCount'=>count($rows), 'publishedArticles'=>count($published), 'savedDraftVersions'=>$drafts, 'statusVersions'=>$statuses];
    }
    private function reportTitle(array $row): array
    {
        $item = ['cid'=>(int)$row['cid'], 'title'=>html_entity_decode($row['title'] ?? '', ENT_QUOTES, 'UTF-8')];
        if (!$this->reportPublished($row)) $item += ['rootCid'=>$this->reportRoot($row),'variant'=>$row['type'],'status'=>$row['status']];
        return $item;
    }
    private function reportPath(array $terms, int $mid): array
    {
        $path = []; $seen = [];
        while ($mid && isset($terms[$mid])) {
            $this->demand(!isset($seen[$mid]), 'invalid-hierarchy', 409); $seen[$mid] = true;
            $term = $terms[$mid]; array_unshift($path,['id'=>$mid,'name'=>$term['name']]);
            $mid = $term['type'] === 'category' ? (int)$term['parent'] : 0;
        }
        return $path;
    }
    private function reportTerm(array $terms, int $mid): array
    {
        $term = $terms[$mid];
        return ['id'=>$mid,'name'=>$term['name'],'parent'=>(int)$term['parent'],'path'=>array_column($this->reportPath($terms,$mid),'name')];
    }
    private function reportDate(int $seconds, string $unit): string
    {
        if ($seconds <= 0) return 'unknown';
        return (new \DateTimeImmutable('@'.$seconds))->setTimezone(new \DateTimeZone('Asia/Shanghai'))->format(['day'=>'Y-m-d','month'=>'Y-m','year'=>'Y'][$unit]);
    }
    private function reportPage(array $items, int $page, int $size): array
    {
        return ['items'=>array_slice($items,($page-1)*$size,$size), 'totalItems'=>count($items), 'page'=>$page, 'pageSize'=>$size, 'hasMore'=>$page*$size < count($items)];
    }
    private function reportComments(array $roots): array
    {
        if (!$roots) return [];
        $db = $this->bridgeDb; $out = [];
        $rows = $db->fetchAll($db->select('cid','status','COUNT(*) AS total')->from('table.comments')->where('cid IN ?', $roots)->where('type = ?', 'comment')->group('cid, status'));
        foreach ($rows as $row) { $status = in_array($row['status'],['approved','waiting','spam'],true) ? $row['status'] : 'other'; $out[(int)$row['cid']][$status] = ($out[(int)$row['cid']][$status] ?? 0) + (int)$row['total']; }
        return $out;
    }
}
