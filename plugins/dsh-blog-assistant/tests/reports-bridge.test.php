<?php
/** Read-only report behaviour on SQLite; TYPECHO_QUERY_DIR additionally runs the real Typecho 1.2.1 query compiler. */
namespace Typecho\Plugin { interface PluginInterface {} }
namespace Widget { interface ActionInterface {} }
namespace Widget\Contents\Post { class Edit {} }
namespace Widget\Base { class Contents { public static function alloc(){return new self;} public function filter($row){return ['permalink'=>'/archives/'.$row['cid'].'/'];} } }
namespace Typecho {
    class Widget {}
    class Db {
        const WRITE=2, READ=1, SELECT='SELECT', INNER_JOIN='INNER', SORT_ASC='ASC', SORT_DESC='DESC';
        public $pdo, $queries=[], $transaction=false, $adapter, $storageChecks=0, $engine='InnoDB';
        public function getPrefix(){return 'typecho_';}
        public function __construct(){
            $this->pdo=new \PDO('sqlite::memory:');$this->pdo->setAttribute(\PDO::ATTR_ERRMODE,\PDO::ERRMODE_EXCEPTION);
            $this->pdo->sqliteCreateFunction('LOCATE',fn($needle,$haystack)=>($p=strpos(strtolower($haystack),strtolower($needle)))===false?0:$p+1,2);
            if(getenv('TYPECHO_QUERY_DIR'))$this->adapter=new \ReportAdapter($this->pdo);
        }
        public function select(...$columns){return $this->adapter?(new \Typecho\Db\Query($this->adapter,'typecho_'))->select(...$columns):new \ReportQuery($this->pdo,$columns);}
        public function query($sql,$mode=null){
            if(str_starts_with($sql,'SET TRANSACTION'))return;
            if(str_starts_with($sql,'START TRANSACTION')){$this->transaction=true;return $this->pdo->exec('BEGIN');}
            if($sql==='ROLLBACK'){$this->transaction=false;return $this->pdo->exec($sql);}
            throw new \RuntimeException('Reports must not write: '.$sql);
        }
        public function fetchAll($query){
            if($query==='SHOW TABLE STATUS'){$this->storageChecks++;return array_map(fn($name)=>['Name'=>'typecho_'.$name,'Engine'=>$this->engine],['contents','fields','relationships','metas','comments','dsh_blog_receipts']);}
            $sql=$this->adapter?$query->prepare((string)$query):(string)$query;$this->queries[]=$sql;return $this->pdo->query($sql)->fetchAll(\PDO::FETCH_ASSOC);
        }
    }
}
namespace {
    class ReportQuery {
        private $pdo,$fields,$table,$joins=[],$conditions=[],$orders=[],$groups='',$take=null,$skip=0;
        public function __construct($pdo,$columns){$this->pdo=$pdo;$this->fields=implode(',',$columns?:['*']);}
        public function from($s){$this->table=$s;return $this;}
        public function join($table,$condition){$this->joins[]=' INNER JOIN '.$table.' ON '.$condition;return $this;}
        public function where($s,...$values){if(str_contains($s,'SELECT '))throw new RuntimeException('raw subqueries unsupported by Typecho where');foreach($values as $v){$q=is_array($v)?'('.implode(',',array_map(fn($x)=>$this->pdo->quote((string)$x),$v)).')':$this->pdo->quote((string)$v);$s=substr_replace($s,$q,strpos($s,'?'),1);}$this->conditions[]='('.$s.')';return $this;}
        public function order($s,$direction){$this->orders[]=$s.' '.$direction;return $this;}
        public function group($s){$this->groups=$s;return $this;}
        public function limit($n){$this->take=$n;return $this;}
        public function offset($n){$this->skip=$n;return $this;}
        public function __toString(){return str_replace('table.','typecho_','SELECT '.$this->fields.' FROM '.$this->table.implode('',$this->joins).($this->conditions?' WHERE '.implode(' AND ',$this->conditions):'').($this->groups?' GROUP BY '.$this->groups:'').($this->orders?' ORDER BY '.implode(',',$this->orders):'').($this->take!==null?' LIMIT '.$this->take.' OFFSET '.$this->skip:''));}
    }
    if($native=getenv('TYPECHO_QUERY_DIR')){
        require $native.'/Adapter.php';require $native.'/Query.php';
        class ReportAdapter implements \Typecho\Db\Adapter {
            private $pdo;public function __construct($pdo){$this->pdo=$pdo;}
            public static function isAvailable():bool{return true;}
            public function connect(\Typecho\Config $config){}
            public function getVersion($handle):string{return 'test';}
            public function getDriver():string{return 'sqlite';}
            public function truncate(string $table,$handle){throw new RuntimeException('write');}
            public function query(string $query,$handle,int $op=\Typecho\Db::READ,?string $action=null,?string $table=null){throw new RuntimeException('unused');}
            public function fetch($resource):?array{return null;}
            public function fetchAll($resource):array{return [];}
            public function fetchObject($resource):?object{return null;}
            public function quoteValue($value):string{return $this->pdo->quote((string)$value);}
            public function quoteColumn(string $name):string{return '`'.str_replace('`','``',$name).'`';}
            public function parseSelect(array $s):string{$joins='';foreach($s['join'] as [$table,$condition,$type])$joins.=' '.$type.' JOIN '.$table.' ON '.$condition;return 'SELECT '.$s['fields'].' FROM '.$s['table'].$joins.$s['where'].$s['group'].$s['having'].$s['order'].($s['limit']!==null?' LIMIT '.$s['limit'].' OFFSET '.($s['offset']??0):'');}
            public function affectedRows($resource,$handle):int{return 0;}
            public function lastInsertId($resource,$handle):int{return 0;}
        }
    }
    if(!function_exists('mb_strlen')){function mb_strlen($s){return strlen($s);}}
    define('__TYPECHO_ROOT_DIR__',__DIR__);
    require __DIR__.'/../typecho/DshBlogBridge/Plugin.php';
    function check($v,$message){if(!$v)throw new RuntimeException($message);}
    function rejects($fn,$code){try{$fn();}catch(Throwable $e){check($e->getCode()===$code,'unexpected error: '.$e->getMessage());return;}throw new RuntimeException('expected rejection');}
    $db=new \Typecho\Db;
    $db->pdo->exec('CREATE TABLE typecho_contents(cid INTEGER PRIMARY KEY,parent INTEGER,title TEXT,text TEXT,type TEXT,status TEXT,created INTEGER,modified INTEGER);
        CREATE TABLE typecho_metas(mid INTEGER PRIMARY KEY,name TEXT,slug TEXT,parent INTEGER,type TEXT,count INTEGER);
        CREATE TABLE typecho_relationships(cid INTEGER,mid INTEGER);
        CREATE TABLE typecho_comments(coid INTEGER PRIMARY KEY,cid INTEGER,status TEXT,type TEXT);');
    $insert=$db->pdo->prepare('INSERT INTO typecho_contents VALUES(?,?,?,?,?,?,?,?)');
    $midnight=(new DateTimeImmutable('2026-09-08T00:00:00+08:00'))->getTimestamp();
    for($i=1;$i<=145;$i++)$insert->execute([$i,0,'文章'.$i.'：100%_查询','PRIVATE_BODY_MARKER','post','publish',$midnight-86400,$midnight+($i===2?-1:0)]);
    $insert->execute([1001,1,'文章1的保存稿','PRIVATE_BODY_MARKER','post_draft','draft',$midnight,$midnight+1]);
    $db->pdo->exec("INSERT INTO typecho_metas VALUES(1,'技术','tech',0,'category',999),(2,'Java','java',1,'category',999),(3,'JVM','jvm',2,'category',999),(4,'空分类','empty',0,'category',999),(5,'Java','java-other',0,'category',0),(10,'后端','backend',0,'tag',999),(11,'空标签','empty-tag',0,'tag',999);
        INSERT INTO typecho_relationships VALUES(1,1),(1,2),(1,10),(2,3),(3,1),(3,10),(1001,3);
        INSERT INTO typecho_comments VALUES(1,1,'approved','comment'),(2,1,'approved','comment'),(3,1,'waiting','comment'),(4,1,'spam','comment'),(5,1,'approved','pingback'),(6,2,'approved','comment');");
    $ref=new ReflectionClass('DshBlogBridge_Action');$action=$ref->newInstanceWithoutConstructor();$ref->getProperty('bridgeDb')->setValue($action,$db);
    $run=fn($mode,$args=[])=>$ref->getMethod('report')->invoke($action,['report'=>$mode]+$args);
    $db->engine='MyISAM';rejects(fn()=>$run('overview'),503);check(!$db->transaction,'nontransactional storage cannot claim a snapshot');$db->engine='InnoDB';
    rejects(fn()=>$run([]),400);
    $db->queries=[];$old=[];$oldCalls=0;
    do{$part=$ref->getMethod('searchPosts')->invoke($action,['status'=>'all','page'=>++$oldCalls]);$old[]=$part;}while($part['hasMore']);
    $oldQueries=count($db->queries);$oldBytes=strlen(json_encode($old,JSON_UNESCAPED_UNICODE));
    check($oldCalls===5&&array_sum(array_map(fn($p)=>count($p['items']),$old))===146,'baseline must reproduce 5 pages and 146 versions');
    $db->queries=[];$all=$run('overview',['filters'=>['status'=>'all']]);
    check($all['totals']['articleCount']===145&&$all['totals']['versionCount']===146&&$all['totals']['publishedArticles']===145&&$all['totals']['savedDraftVersions']===1,'root dedup and draft versions');
    check(count($db->queries)===5,'overview uses 5 batch SELECTs regardless of article count');
    check($all['articlesWithSavedDraft']===1,'pending changes counted');
    check($all['comments']===['approved'=>3,'waiting'=>1,'spam'=>1,'other'=>0],'native comments exclude pingbacks');
    $default=$run('overview');check($default['totals']['versionCount']===145,'new reports default to published');
    check($default['articlesWithUncategorizedVersion']===142&&$default['articlesWithUntaggedVersion']===143,'missing metadata counts');
    $db->pdo->exec('DELETE FROM typecho_relationships WHERE mid=1');$childOnly=$run('overview');check($childOnly['taxonomy']['category']['usedInScope']===3,'parent with only child articles is not empty');$db->pdo->exec('INSERT INTO typecho_relationships VALUES(1,1),(3,1)');
    $taxonomy=$run('taxonomy');$nodes=array_column($taxonomy['items'],null,'id');
    check($nodes[1]['articleCount']===2&&$nodes[1]['subtreeArticleCount']===3,'direct and subtree counts deduplicate multiple memberships');
    check($nodes[2]['articleCount']===1&&$nodes[2]['subtreeArticleCount']===2&&$nodes[3]['path']===['技术','Java','JVM'],'hierarchy and descendants');
    check($run('taxonomy',['emptyOnly'=>true])['totalItems']===2,'empty parent scopes');
    check($run('taxonomy',['kind'=>'tag','emptyOnly'=>true])['items'][0]['id']===11,'empty tags');
    $taxPage=$run('taxonomy',['pageSize'=>2]);check($taxPage['totalItems']===5&&$taxPage['hasMore']&&count($taxPage['items'])===2,'taxonomy totals survive paging');
    check($run('overview',['filters'=>['categoryId'=>1,'includeDescendants'=>true]])['totals']['articleCount']===3,'subtree filter');
    check($run('overview',['filters'=>['category'=>'技术','includeDescendants'=>true]])['totals']['articleCount']===3,'subtree by name');
    check($run('overview',['filters'=>['categoryId'=>5]])['totals']['articleCount']===0,'ID disambiguates duplicate names');
    check($run('overview',['filters'=>['category'=>'Java','tag'=>'后端']])['totals']['articleCount']===1,'category/tag intersection');
    check($run('overview',['filters'=>['content'=>'PRIVATE_BODY_MARKER','title'=>'100%_']])['totals']['articleCount']===145,'literal title and content filters');
    check($run('overview',['filters'=>['missing'=>'both']])['totals']['articleCount']===142,'missing both');
    check($run('overview',['filters'=>['hasSavedDraft'=>true]])['totals']['articleCount']===1,'pending-only query');
    $db->queries=[];$catalog=$run('catalog');
    check(!$catalog['hasMore']&&$catalog['totals']['articleCount']===145&&$catalog['totalEntries']===146,'catalog complete in one call, memberships differ from unique articles');
    check(count($db->queries)===4,'catalog uses four batch SELECTs');
    check(!str_contains(json_encode($catalog),'PRIVATE_BODY_MARKER'),'no body returned');
    $catalogAll=$run('catalog',['filters'=>['status'=>'all']]);
    check($catalogAll['totals']===$all['totals']&&!$catalogAll['hasMore'],'all-version catalog and baseline have identical article scope');
    check(strlen(json_encode($catalogAll,JSON_UNESCAPED_UNICODE))<$oldBytes/3,'compact titles stay below one third of ordinary search response bytes');
    $flat=$run('catalog',['groupBy'=>'none','filters'=>['status'=>'all']]);$oldIds=[];foreach($old as $part)foreach($part['items'] as $item)$oldIds[]=$item['cid'];$flatIds=array_column($flat['groups'][0]['items'],'cid');sort($oldIds);sort($flatIds);check($flatIds===$oldIds,'all-version compact catalog retains every baseline article version');
    $tagGroups=array_column($run('catalog',['groupBy'=>'tag'])['groups'],null,'id');check($tagGroups[10]['articleCount']===2&&$tagGroups[0]['articleCount']===143,'tag catalog includes untagged articles');
    check($run('catalog',['groupBy'=>'year','filters'=>['dateField'=>'created']])['groups'][0]['name']==='2026','catalog supports article-year archives');
    $combined=[];$page=0;do{$part=$run('catalog',['page'=>++$page,'pageSize'=>31]);foreach($part['groups'] as $g)foreach($g['items'] as $item)$combined[]=$g['id'].':'.$item['cid'];}while($part['hasMore']);
    check(count($combined)===146&&count(array_unique($combined))===146,'catalog pages neither skip nor duplicate memberships');
    $daily=$run('timeline',['groupBy'=>'day']);$days=array_column($daily['items'],null,'period');
    check($days['2026-09-07']['articleCount']===1&&$days['2026-09-08']['articleCount']===144,'Shanghai midnight buckets');
    $month=$run('timeline',['groupBy'=>'month','filters'=>['dateField'=>'created']]);check($month['items'][0]['period']==='2026-09'&&$month['items'][0]['articleCount']===145,'monthly totals by selected article date');
    $today=$run('overview',['start'=>$midnight,'end'=>$midnight+86400]);check($today['totals']['articleCount']===144,'inclusive start/exclusive end');
    $ranking=$run('ranking',['sortBy'=>'comments','pageSize'=>2]);check(array_column($ranking['items'],'cid')===[1,2]&&$ranking['items'][0]['approvedComments']===2,'comment ranking');
    check($run('ranking',['filters'=>['status'=>'all'],'pageSize'=>500])['totalItems']===145,'rankings deduplicate roots');
    $empty=$run('catalog',['filters'=>['query'=>'not found']]);check(!$empty['hasMore']&&$empty['totals']['articleCount']===0&&$empty['groups']===[],'empty reports are complete');
    foreach([['pageSize'=>0],['pageSize'=>501],['page'=>0],['filters'=>['unknown'=>1]],['filters'=>['categoryId'=>'1']],['filters'=>['includeDescendants'=>true]],['filters'=>['missing'=>'x']],['filters'=>['category'=>[],'includeDescendants'=>true]],['start'=>$midnight,'end'=>$midnight]] as $invalid)rejects(fn()=>$run('catalog',$invalid),400);
    $insert->execute([1002,0,'独立草稿','private','post_draft','draft',$midnight,$midnight]);$insert->execute([1003,0,'私密文章','private','post','private',$midnight,$midnight]);
    $draft=$run('overview',['filters'=>['status'=>'draft']]);check($draft['totals']['articleCount']===3&&$draft['totals']['savedDraftVersions']===2&&$draft['totals']['publishedArticles']===0,'draft/private scope distinguishes statuses');
    $db->pdo->exec('UPDATE typecho_metas SET parent=3 WHERE mid=1');rejects(fn()=>$run('taxonomy'),409);check(!$db->transaction,'failed report rolls back read transaction');$db->pdo->exec('UPDATE typecho_metas SET parent=0 WHERE mid=1');
    $db->pdo->beginTransaction();for($i=2000;$i<22000;$i++)$insert->execute([$i,0,'bulk','private','post','publish',0,0]);$db->pdo->commit();
    rejects(fn()=>$run('overview'),413);check(!$db->transaction,'oversized scope fails closed, no partial total');
    echo json_encode(['compiler'=>getenv('TYPECHO_QUERY_DIR')?'Typecho 1.2.1 native Query':'test SQL builder','scope'=>'all: 145 articles / 146 versions; bytes are bridge data JSON, not tokens; reports each additionally check storage engines once','baseline'=>['toolCalls'=>$oldCalls,'selects'=>$oldQueries,'bytes'=>$oldBytes],'catalog'=>['toolCalls'=>1,'selects'=>4,'bytes'=>strlen(json_encode($catalogAll,JSON_UNESCAPED_UNICODE))],'overview'=>['toolCalls'=>1,'selects'=>5,'bytes'=>strlen(json_encode($all,JSON_UNESCAPED_UNICODE))]],JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE)."\n";
    echo "PASS: counts, hierarchy, filters, dates, compact catalog, rankings, paging, errors and read-only snapshots (SQLite)\n";
}
