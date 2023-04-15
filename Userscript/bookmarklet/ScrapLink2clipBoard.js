javascript:(function(){ 
        if(window.confirm('ScrapLink Copy to Clipboard?')){
            setTimeout(() => navigator.clipboard.writeText('['+document.title.replace(/\s*[\[\]]\s*/g,' ')+' '+location.href+']'), 100)
        }
    }
    )();
