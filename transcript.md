Jun 11, 2026
Varys Revamp Transcript - Transcript
00:00:31

Mothil V: Hey um so I just wanted to uh take a note on uh this new feature called varys. So V A R Y S. Uh so varys is nothing but a testing automation framework right um we can assume it like some kind of a framework where people will record the test cases and they'll rerun the test cases I mean so so okay so this is how it happens right so a user comes in uh he'll uh go to a specific URL he'll record a test case and then post that uh uh so the recording involves everything like he'll click he can he do that does that everything in that application he logs in


00:01:09

Mothil V: and then he'll take a screenshot of a particular div as in he can uh do anything right he can take a screenshot of a div a span or anything so so that'll be an I don't know maybe a toolbox where uh to take a screenshot right so you can click that toolbox you'll be you'll get hover elements for on each divs and on each div and then you can just click it to take a screenshot of that right so that's how test


00:01:32

Mothil V: is created and then I mean once a test is created uh then the user can run that again right anywhere whenever he wants And then he needs to compare the screenshots. Okay. Hey, this is the screenshot which I have taken, right? And uh I mean so a baseline will be created baseline image. So each and every time the test runs the two images needs to be compared.


00:01:53

Mothil V: Maybe some kind of a good UI to compare those images and and see like what exactly is wrong with these two images, right? I mean if anything deviated then that particular test image will fail. Uh if things are fail then yeah everything should work. Right. Correct. So yeah, I mean so I'll just give you overview on what the feature is, right?


00:02:14

Mothil V: So it's it'll basically have an it's just an hover state, right? And uh it should be able to handle everything be it scrolling, clicking, hover state, anything, right? And I must be able to take a screenshot of a particular do like the whole D like whatever like I I'll use play uh playright right to take a screenshot and everything.


00:02:34

Mothil V: And the main thing that I need to do here is that at some scenarios I might need to wait for an API call to happen before taking a screenshot. So I might need a good provision for that as well. For example, let's say hey before taking the screenshot, wait for this API like I can give a pattern or I must be able to give a specific number of seconds before it.


00:02:53

Mothil V: Hey uh before you know start uh taking a screenshot wait for this much seconds know maybe for animations to settle everything. I must be able to configure that in each step, right? And then one more thing is that I need some kind of a uh and so how this should look like is that the UI right it should be something like a um a timeline right uh video timeline for example let's say you're playing a


00:03:19

Mothil V: video and uh I mean the play rate right it must be able to record that whole everything like whatever I do over there right uh play rate should actually record it uh actually screen record it right and it should create some kind of a UI which shows a time uh the video recording along with that timeline below it in that timeline I can see wherever I have clicked something where I have done any kind of action okay this is where the screenshot is taken this is where this is taken and everything so he can see the whole timeline view of what has


00:03:48

Mothil V: happened right so that's the main part and he can click it he can you know uh uh see okay this is where this has happened and everything right and then uh yeah and even each test case can be you know recorded uh while okay let's say you are running let's say this baseline is created best test case is created say you are running that again running that u thing again you must be able to uh compare those screenshot with the new recording as well so yeah uh that's the whole idea right and one more thing that uh we need to keep in mind is that so each test


00:04:23

Mothil V: case right must be we must be able to group it as in we must be able to group it as a I don't know maybe uh consider some kind of a folders right that folders can be a release right a release can have a series of tests and uh like for example hey this I tested that I tested this and everything and a uh uh a folder can be a group of features right uh let's say hey this this is let's say that's a feature called uh dashboard hey these are the test cases that were created for dashboard I I add it to the folder and the folder can be


00:04:58

Mothil V: a customer right okay this is the customer for this customer I have created these test cases and that that those test cases will automatically run right so that's the thing here and yeah we need to figure out how to do the schema and everything for this right so yeah the basic idea is like let's say I'm doing a release I must be able to run all the test cases inside it as a whole for example let's say uh a release


00:05:22

Mothil V: uh let's say we are doing a release zero uh version 5.0 in 5.0 0 let's say there are around six things we are uh six new uh changes that we have made so those six new changes will have a six let's say six separate test cases I must be able to group them and I must be able to run them let's say I'm doing release I'll just run that particular release once and I'll see what's what's happening okay hey uh okay is this release fine and this can be done at a feature level as well for example let's say there's a feature called


00:05:51

Mothil V: dashboard the dashboard can have multiple elements like dashboard for metric card dashboard for bar chart dashboard for line chart. So let's say these are the three different test suits. I must be able to group them under a single folder called dashboard uh feature level and then you can just you know u run that as a whole. I can just click it the whole suit will run and it'll say okay hey this failed or this passed and I can even run a particular thing separately.


00:06:18

Mothil V: For example let's say inside a dashboard I can just test that bar set separately. All of these must be logged in a way. So I'm thinking of how to differentiate. We need to think about how to differentiate this uh folder like at what level do we need to differentiate it? uh I mean do we need to differentiate or can we have some kind of a tag mechanism where each folder can be tagged with a custom tag for example I can tag it as a release I can tag it as I can create a tag feature I can create a tag uh


00:06:44

Mothil V: customer anything right so that's I can also create a custom tag anything so that's the thing on how do we uh do that right then one more thing that we need to keep in mind is that Um so the recording right so we need to make a figure out the best way to record. So a recording I mean so as is basically a react application right.


00:07:16

Mothil V: So I mean react application but the testing recorder will happen in browser. React has no involvement in it. The testing application will happen uh in a browser. So as in a browser so we need to think about how this can be done as in each steps right what do we actually record? For example, let's say you record it saying that okay uh hey this is the button this button okay let's say this is the label that you need to take a screenshot let's say we record a step saying that this label has a text uh


00:07:48

Mothil V: retail omnis sessions right but that may differ in different environments for example retail omnis is a data set name the data set name can be it's just different across multiple uh we have different environments dev demo lnrs cfg carvana like these are the different environments we have. So we need to figure out how can we create a single test and run it all over.


00:08:12

Mothil V: So we the recording right it should be domain agnostic it shouldn't be like it shouldn't take actually the data I mean the images should be different for sure right so each will have its own baselines sure but the test case the actual uh uh test case that we record right that should be agnostic as much as possible it's not like I for each environment I need to create a test case for each and every features so it shouldn't be like that so the recorder should handle that right and there can be any self-


00:08:41

Mothil V: failing mechanism for recorder and everything like how does it record the whole thing can be you know like what do we log when a user clicks on while recording when a user clicks on what do we actually store do we store the x path do we store the I don't know the full x path the partial x path or the ID name anything right so we need to think about it and this should be like an independent yeah so so we need


00:09:04

Mothil V: to figure out the whole architecture behind it like what database to use uh how should the recorder look like uh the UI for it UI should in React. So how do we do the UI for it and how do we run all these three like what's the best database do we go for SQL or NoSQL all these decisions we need to make right and yeah and finally right once everything is done so so this is the manual flow asn't this is what the user would do manually right he must be able to do this in a manual way right and we need a very flourishing way for showing the recording


00:09:40

Mothil V: like video should play with each and every checkpoints wherever it happened and the user must be able to trace what exactly happened and what exactly went wrong the whole thing right and he must be able to switch the recording on or off for a particular test right even that should be possible let's say let's say a test fails to figure out why why it fails he can just turn it on he can just turn on the recording and he can do that thing but the baseline can be auto


00:10:03

Mothil V: recorded for sure right it needs to compare so to show the checkpoints and everything the baseline thing can be recorded for sure right So one thing that we need to remember is that for now let's keep all the files locally. The storage can be a local system right in the future we'll be moving them to an Azure blob.


00:10:19

Mothil V: Uh just mine this uh so for now right so we need to give compatibility for both an environment variable where you say storage can be local or Azure. So it should be the the whole storage architecture should be uh agnostic any framework agnostic I can maybe I can go for AWS in the future right so you need to be able to isolate that in a separate way I can even uh use the local files to store my thing or I can go for any Azure uh AWS so this whole storage feature the way the way you store the recordings the way you store baselines and the actual test case screenshots all


00:10:57

Mothil V: these things should uh should should be configurable as in where to store. It can be in local storage or anywhere. So that should be highly configurable maybe in a react uh maybe in an environment variable or something right and apart from that so once these things are done right once or all of these things are done so this is the manual flow right the user can do anything manual then we need to think


00:11:21

Mothil V: about how can cloud code automate automate this for example let's say I give an SRS and I let's say I give a design to you right then and maybe you you give me what all to test it what all button to click what all screenshots to take and everything. Is there any way that claude can instead of a user going and recording that each and every step and everything is there any way cloud code maybe I don't know I'm just brainstorming here it can be an MCP


00:11:48

Mothil V: or some some kind of a way where cloud code can actually run this test it can create the actual the recording right the cloud code can actually do that instead of the user going user should be able to do that manually for sure but is there any way cloud can do that so that's the next uh that's the extension of this state first we need to figure out how can a user uh do this I mean do everything that I've said


00:12:10

Mothil V: before that we'll be thinking about how can we actually uh you know uh create this and uh how can I actually create this and how can we how can we automate this using cloud code right so the steps would be something like this right uh let's say uh we have SRS phase where you have the whole feature about all the feature and everything and maybe I can give screenshot of that uh UI to it hey this is looks like and everything or I don't know maybe even claude can go


00:12:39

Mothil V: and take screenshots and actually figure out what test cases to run right and it actually clicks things and takes screenshot and creates a whole new layer right so claude does that automatically once cloud does that it will be stored and then it can go under so once then that's done right maybe it's it's it's in a draft state or something that can be moved into as I said earlier it can be moved under a feature folder release fold or customer folder right And that can be rerun again using at a top level or even at a particular flow level. So yeah, that's pretty much it. And uh yeah.


Transcription ended after 00:13:24

This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
