import {createEditor,$getRoot,KEY_ENTER_COMMAND,COMMAND_PRIORITY_HIGH} from 'lexical';
import {registerRichText} from '@lexical/rich-text';
const el=document.querySelector('#main footer div[contenteditable]');
const editor=createEditor({namespace:'wa',onError:e=>console.error(e)});
editor.setRootElement(el);
registerRichText(editor);
window.sent=[];
function send(){editor.getEditorState().read(()=>{window.sent.push($getRoot().getTextContent())});editor.update(()=>$getRoot().clear());}
editor.registerCommand(KEY_ENTER_COMMAND,(e)=>{if(e&&e.shiftKey)return false;e&&e.preventDefault();send();return true;},COMMAND_PRIORITY_HIGH);
document.querySelector('#sendbtn').addEventListener('click',send);
window.typeText=(t)=>{el.focus();document.execCommand('insertText',false,t)};
