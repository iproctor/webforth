: _dict_current dict_start @ ;

: _dict_current_set dict_start ! ;

: align4 3 + -4 and ;

: _dict_entry_len @ 8 + ;
: _dict_entry_does_fn_id 4 + @ ;
: _dict_entry_label_addr 8 + ;
: _dict_entry_label_len _dict_entry_label_addr @ ;
: _dict_entry_data_addr dup _dict_entry_label_len align4 swap _dict_entry_label_addr + ;
: _dict_entry_end dup _dict_entry_len + ;

: _dict_current_set_does _dict_current 4 + ! ;

: _dict_advance_current
  _dict_current 0 =
  if
    dict_start 4 +
  else
    _dict_current _dict_entry_end
  then
    dup _dict_current_set ;

: create
  _dict_advance_current
    dup _dict_entry_label_addr _writeStreamWord align4 swap !
  ;

: ,  _dict_current
  dup _dict_entry_end rot swap !
  dup @ 4 + swap ! ;

: variable create 0 , ;

: v postpone >r ' compile, postpone r> ; immediate
: v. postpone dup postpone v ; immediate

: do ]] 2>r begin [[ ; immediate

: +loop ]]
    r> + dup >r
    rover r> = if break then
    again
    rdrop rdrop
    [[ ; immediate

: loop ]] 1 +loop [[ ; immediate

: until ]] if break then again [[ ; immediate
