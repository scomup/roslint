import {ChildProcess, execFile, execFileSync} from 'child_process';
import * as vscode from 'vscode';

class ChildProcessWithExitFlag {
  constructor(process: ChildProcess) {
    this.process = process;
    this.exited = false;

    process.on('exit', () => (this.exited = true));
  }

  process: ChildProcess;
  exited: boolean;
}

let rosLintProcess: ChildProcessWithExitFlag|undefined = undefined;

export function killRosLint() {
  if (rosLintProcess === undefined || rosLintProcess.exited ||
      rosLintProcess.process.killed) {
    return;
  }

  // process.kill() does not work on Windows for some reason.
  // We can use the taskkill command instead.
  if (process.platform === 'win32') {
    const pid = rosLintProcess.process.pid.toString();
    execFileSync('taskkill', ['/pid', pid, '/f', '/t']);
  } else {
    rosLintProcess.process.kill();
  }
}

export function runRosLint(
    files: string[], workingDirectory: string,
    loggingChannel: vscode.OutputChannel): Promise<string> {
  killRosLint();

  return new Promise((resolve) => {
    const lint = files[0].split('/').reverse()[0].split('.')[1] == 'py' ?
        'pycodestyle' :
        'cpplint_wrapper';
    const rosLint = 'python3';
    const args = ['-m', `roslint.${lint}`].concat(files);

    loggingChannel.appendLine(`> ${rosLint} ${args.join(' ')}`);
    loggingChannel.appendLine(`Working Directory: ${workingDirectory}`);
    new Promise((res, rej) => {
      rosLintProcess = new ChildProcessWithExitFlag(execFile(
          rosLint, args, {cwd: workingDirectory}, (error, stdout, stderr) => {
            loggingChannel.appendLine(stdout);
            loggingChannel.appendLine(stderr);
            resolve(lint == 'cpplint_wrapper' ? stderr : stdout);
            res();
          }));
    });
  });
}

interface RosLintResults {
  MainSourceFile: string;
  Diagnostics: RosLintDiagnostic[];
}

interface RosLintDiagnostic {
  DiagnosticName: string;
  DiagnosticMessage: {
    Message: string; FilePath: string; FileLine: number;
    Severity: vscode.DiagnosticSeverity | vscode.DiagnosticSeverity.Warning;
  };
}

function roslintOutputAsObjectCpp(rosLintOutput: string) {
  let lines = rosLintOutput.split(/\n/);
  if (lines.length <= 3) {
    return {MainSourceFile: '', Diagnostics: []};
  }

  const lintResult = lines.slice(0, -3);
  const sourceFile =
      rosLintOutput.match(/([^/]*)\..*?:/)![1].split('/').reverse()[0];
  let structuredResults: RosLintResults = {
    MainSourceFile: sourceFile,
    Diagnostics: [],
  };

  lintResult.forEach((line) => {
    let elements = line.split(/:|\[|\]/)
    structuredResults.Diagnostics.push({
      DiagnosticName: elements[3],
      DiagnosticMessage: {
        Message: elements[2].trim(),
        FilePath: elements[0],
        FileLine: Number(elements[1]) > 0 ? Number(elements[1]) - 1 : 0,
        Severity: vscode.DiagnosticSeverity.Warning,
      },
    });
  });

  return structuredResults;
}

function roslintOutputAsObjectPy(rosLintOutput: string) {
  let lines = rosLintOutput.split(/\n/);
  if (lines.length <= 1) {
    return {MainSourceFile: '', Diagnostics: []};
  }

  const lintResult = lines.slice(0, -1);
  const sourceFile =
      rosLintOutput.match(/([^/]*)\..*?:/)![1].split('/').reverse()[0];
  let structuredResults: RosLintResults = {
    MainSourceFile: sourceFile,
    Diagnostics: [],
  };

  lintResult.forEach((line) => {
    let elements = line.split(/:/)
    let message = elements[3].match(/([A-Z]\d*?) (.*)/);
    structuredResults.Diagnostics.push({
      DiagnosticName: message ? message[1] : '',
      DiagnosticMessage: {
        Message: message ? message[2] : '',
        FilePath: elements[0],
        FileLine: Number(elements[1]) > 0 ? Number(elements[1]) - 1 : 0,
        Severity: vscode.DiagnosticSeverity.Warning,
      },
    });
  });

  return structuredResults;
}

export function collectDiagnostics(
    rosLintOutput: string, document: vscode.TextDocument) {
  let results: vscode.Diagnostic[] = [];


  const roslintResults =
      document.fileName.split('/').reverse()[0].split('.')[1] == 'py' ?
      roslintOutputAsObjectPy(rosLintOutput) :
      roslintOutputAsObjectCpp(rosLintOutput);

  roslintResults.Diagnostics.forEach((diag) => {
    const diagnosticMessage = diag.DiagnosticMessage;

    // We make these paths relative before comparing them because
    // on Windows, the drive letter is lowercase for the document filename,
    // but uppercase for the diagnostic message file path. This caused the
    // comparison to fail when it shouldn't.
    if (vscode.workspace.asRelativePath(document.fileName) !==
        vscode.workspace.asRelativePath(diagnosticMessage.FilePath)) {
      return; // The message isn't related to current file
    }


    results.push({
      range: new vscode.Range(
          diagnosticMessage.FileLine, 0, diagnosticMessage.FileLine,
          Number.MAX_VALUE),
      severity: diagnosticMessage.Severity,
      message: diagnosticMessage.Message,
      code: diag.DiagnosticName,
      source: 'roslint',
    });
  });

  return results;
}
