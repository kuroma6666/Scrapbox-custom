javascript:
(
    function(){
        var title=window.prompt(`Scrap "${document.title}" to kuroma6666.`,document.title);
        if (!title) return;
        var currentURL = window.location.href;
        const ricapitolareURL = 'https://ricapitolare.vercel.app/svg?url=';
        var lines = ['',('['+ricapitolareURL+currentURL+'#.svg'+' '+currentURL+']')];
        var quote=window.getSelection().toString();
        if (quote.trim()) lines=lines.concat(quote.split(/\n/g).map(function(line){return ' > '+line}));
        lines.push('');
        var body=encodeURIComponent(lines.join('\n'));
        window.open('https://scrapbox.io/kuroma6666/'+encodeURIComponent(title.trim())+'?body=%27+body)
    })();
